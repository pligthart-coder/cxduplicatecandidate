/**
 * Vercel Serverless Function — Smart Duplicate Candidate checker (with live progress)
 *
 * Finds likely duplicate candidate PAIRS in Carerix by comparing multiple
 * fields and scoring each pair with a confidence level. The page shows a LIVE
 * progress bar while candidates stream in (Server-Sent Events), then renders
 * the pairs — oldest on the left, newest on the right, with chips explaining
 * why they match and an "Open in Carerix" link.
 *
 * Routes:
 *   /api/duplicates                 → loader page (shows progress, then results)
 *   /api/duplicates?stream=1        → SSE stream (progress events + final HTML)
 *   /api/duplicates?debug=probe     → test each field against the live API
 *   /api/duplicates?debug=schema    → introspect the schema (if enabled)
 *   /api/duplicates?debug=raw       → dump 1 candidate record
 *   /api/duplicates?min=high|medium|low → minimum confidence (default high)
 *   /api/duplicates?scope=owner&ownerId=123 → limit to one owner (optional)
 *
 * Env: CARERIX_CLIENT_ID, CARERIX_CLIENT_SECRET, CARERIX_TOKEN_ENDPOINT
 *      CARERIX_APP_BASE (optional; defaults to the ab2pro tenant).
 */

const CARERIX_GRAPHQL_URI = 'https://api.carerix.io/graphql/v1/graphql';
const PAGE_SIZE = 150;         // fetch candidates in pages of 150
const MAX_PAIRS = 2500;        // stop once this many duplicate pairs are found
const MAX_SCAN = 50000;        // hard safety cap on candidates scanned
const TIME_BUDGET_MS = 50000;  // stop fetching before the serverless time limit

/* ============================================================================
 * CONFIG — field names, confirmed against the live schema.
 * ==========================================================================*/
const CONFIG = {
  queryName: 'crEmployeePage',
  itemSelection: `
    _id
    employeeID
    creationDate
    firstName
    lastNamePrefix
    lastName
    initials
    birthDate
    emailAddress
    businessEmailAddress
    mobileNumber
    mobileNumberBusiness
    phoneNumber
    homePostalCode
    homeCity
    toStatusNode { value }
  `,
  getId:        (c) => c.employeeID ?? c._id,
  getFirstName: (c) => c.firstName,
  getPrefix:    (c) => c.lastNamePrefix,
  getLastName:  (c) => c.lastName,
  getInitials:  (c) => c.initials,
  getEmails:    (c) => [c.emailAddress, c.businessEmailAddress],
  getPhones:    (c) => [c.mobileNumber, c.mobileNumberBusiness, c.phoneNumber],
  getBirth:     (c) => c.birthDate,
  getPostal:    (c) => c.homePostalCode,
  getCity:      (c) => c.homeCity,
  getStatus:    (c) => c.toStatusNode?.value,
  getCreated:   (c) => c.creationDate,
};

// Link to open a candidate in Carerix (hash routing). {id} = employeeID.
const CANDIDATE_URL_PATH = '/#CREmployee/{id}';
const APP_BASE = (process.env.CARERIX_APP_BASE || 'https://ab2pro.carerix.net').replace(/\/$/, '');

// A normalized e-mail/phone shared by more than this many candidates is treated
// as a placeholder (agency e-mail, 000.. phone) and ignored as a match signal.
const MAX_BLOCK = 25;

/* ─── OAuth2 ───────────────────────────────────────────────────────────────*/
async function getAccessToken() {
  const { CARERIX_CLIENT_ID, CARERIX_CLIENT_SECRET, CARERIX_TOKEN_ENDPOINT } = process.env;
  if (!CARERIX_CLIENT_ID || !CARERIX_CLIENT_SECRET || !CARERIX_TOKEN_ENDPOINT) {
    throw new Error('Missing Carerix OAuth environment variables (CARERIX_CLIENT_ID, CARERIX_CLIENT_SECRET, CARERIX_TOKEN_ENDPOINT)');
  }
  const res = await fetch(CARERIX_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(CARERIX_CLIENT_ID)}&client_secret=${encodeURIComponent(CARERIX_CLIENT_SECRET)}`,
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

/* ─── GraphQL helper ────────────────────────────────────────────────────────*/
async function gql(token, query, variables) {
  const res = await fetch(CARERIX_GRAPHQL_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Non-JSON response ${res.status}: ${text.slice(0, 400)}`); }
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 600)}`);
  if (json.errors) {
    const err = new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(' | ')}`);
    err.graphqlErrors = json.errors;
    throw err;
  }
  return json.data;
}

/* ─── Introspection & probe (diagnostics) ───────────────────────────────────*/
async function introspect(token) {
  const query = `
    query Introspect {
      schema: __schema { queryType { fields { name } } }
      CREmployee: __type(name:"CREmployee"){ ...TF }
      CRUser: __type(name:"CRUser"){ ...TF }
      CREmployeePage: __type(name:"CREmployeePage"){ ...TF }
    }
    fragment TF on __Type { name fields { name type { name kind ofType { name } } } }`;
  const data = await gql(token, query, {});
  const flatten = (t) => t && ({ name: t.name, fields: (t.fields || []).map((f) => ({ name: f.name, type: f.type?.name || f.type?.ofType?.name || f.type?.kind })) });
  return {
    employeeRootQueries: (data.schema?.queryType?.fields || []).map((f) => f.name).filter((n) => /mploye|andidate|user/i.test(n)),
    types: { CREmployee: flatten(data.CREmployee), CRUser: flatten(data.CRUser), CREmployeePage: flatten(data.CREmployeePage) },
  };
}

const PROBE_SNIPPETS = ['employeeID', 'creationDate', 'firstName', 'lastName', 'lastNamePrefix', 'initials', 'birthDate', 'emailAddress', 'businessEmailAddress', 'mobileNumber', 'phoneNumber', 'homePostalCode', 'homeCity'];
async function probeAll(token) {
  const one = async (snippet) => {
    const q = `query ($p: Pageable) { ${CONFIG.queryName}(qualifier:"deleted=0", pageable:$p) { items { _id ${snippet} } } }`;
    try { await gql(token, q, { p: { page: 0, size: 1 } }); return { snippet, ok: true }; }
    catch (e) { return { snippet, ok: false, error: e.message.slice(0, 200) }; }
  };
  const results = [];
  for (const s of PROBE_SNIPPETS) results.push(await one(s));
  return { validFields: results.filter((r) => r.ok).map((r) => r.snippet), invalidFields: results.filter((r) => !r.ok) };
}

/* ─── Fetch ─────────────────────────────────────────────────────────────────*/
const PAGE_QUERY = `
  query ($qualifier: String, $pageable: Pageable) {
    ${CONFIG.queryName}(qualifier: $qualifier, pageable: $pageable) {
      items { ${CONFIG.itemSelection} }
    }
  }`;

async function fetchPage(token, qualifier, page) {
  const data = await gql(token, PAGE_QUERY, { qualifier, pageable: { page, size: PAGE_SIZE } });
  return data?.[CONFIG.queryName]?.items || [];
}

async function fetchCandidates(token, qualifier, limitPages) {
  let all = [], page = 0;
  while (true) {
    const items = await fetchPage(token, qualifier, page);
    all = all.concat(items);
    if (items.length < PAGE_SIZE) break;
    if (all.length >= MAX_SCAN) break;
    page++;
    if (limitPages && page >= limitPages) break;
  }
  return all.slice(0, MAX_SCAN);
}

// Best-effort total count for the progress percentage (field may not exist).
async function detectTotal(token, qualifier) {
  for (const f of ['totalElements', 'totalCount', 'total']) {
    try {
      const q = `query ($qualifier:String,$p:Pageable){ ${CONFIG.queryName}(qualifier:$qualifier,pageable:$p){ ${f} } }`;
      const d = await gql(token, q, { qualifier, p: { page: 0, size: 1 } });
      const v = d?.[CONFIG.queryName]?.[f];
      if (typeof v === 'number' && v > 0) return v;
    } catch { /* try next */ }
  }
  return null;
}

/* ─── Normalization ─────────────────────────────────────────────────────────*/
function stripDiacritics(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ""); }
function normEmail(e) { if (!e) return ''; const s = String(e).trim().toLowerCase(); return s.includes('@') ? s : ''; }
function normPhone(p) {
  if (!p) return '';
  let d = String(p).replace(/[^\d+]/g, '').replace(/^00/, '').replace(/^\+/, '');
  if (d.charAt(0) === '0') d = '31' + d.substring(1);
  return d.length >= 6 ? d : '';
}
function normName(s) { return s ? stripDiacritics(String(s).toLowerCase()).replace(/[^a-z0-9]/g, '') : ''; }
function normPostal(s) { return s ? String(s).toUpperCase().replace(/\s+/g, '') : ''; }
function normBirth(s) { if (!s) return ''; const d = new Date(s); return isNaN(d) ? String(s).slice(0, 10) : d.toISOString().slice(0, 10); }

function toRow(c, i) {
  return {
    i,
    id: CONFIG.getId(c),
    firstName: CONFIG.getFirstName(c) || '',
    prefix: CONFIG.getPrefix(c) || '',
    lastName: CONFIG.getLastName(c) || '',
    initials: CONFIG.getInitials(c) || '',
    birth: CONFIG.getBirth(c) || '',
    postal: CONFIG.getPostal(c) || '',
    city: CONFIG.getCity(c) || '',
    status: CONFIG.getStatus(c) || '',
    created: CONFIG.getCreated(c) || '',
    emails: [...new Set(CONFIG.getEmails(c).map(normEmail).filter(Boolean))],
    phones: [...new Set(CONFIG.getPhones(c).map(normPhone).filter(Boolean))],
    nFirst: normName(CONFIG.getFirstName(c)),
    nLast: normName(CONFIG.getLastName(c)),
    nInitials: normName(CONFIG.getInitials(c)),
    nBirth: normBirth(CONFIG.getBirth(c)),
    nPostal: normPostal(CONFIG.getPostal(c)),
  };
}

/* ─── Scoring ───────────────────────────────────────────────────────────────*/
const WEIGHTS = { email: 6, phone: 5, birth: 3, lastName: 2, firstName: 2, initials: 1, postal: 1 };
function scorePair(a, b) {
  const fields = [];
  const shareAny = (x, y) => x.some((v) => y.includes(v));
  if (a.emails.length && shareAny(a.emails, b.emails)) fields.push('email');
  if (a.phones.length && shareAny(a.phones, b.phones)) fields.push('phone');
  if (a.nBirth && a.nBirth === b.nBirth) fields.push('birth');
  if (a.nLast && a.nLast === b.nLast) fields.push('lastName');
  if (a.nFirst && a.nFirst === b.nFirst) fields.push('firstName');
  if (a.nInitials && a.nInitials === b.nInitials) fields.push('initials');
  if (a.nPostal && a.nPostal === b.nPostal) fields.push('postal');
  const score = fields.reduce((n, f) => n + (WEIGHTS[f] || 0), 0);
  const has = (k) => fields.includes(k);
  let level = 'Low';
  if (has('email') || (has('phone') && (has('lastName') || has('firstName'))) || (has('lastName') && has('firstName') && has('birth'))) level = 'High';
  else if (has('phone') || (has('lastName') && has('firstName')) || (has('lastName') && has('birth'))) level = 'Medium';
  return { score, fields, level };
}

function findPairs(rows, minLevel) {
  const emailFreq = new Map(), phoneFreq = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  rows.forEach((r) => { r.emails.forEach((e) => bump(emailFreq, e)); r.phones.forEach((p) => bump(phoneFreq, p)); });
  let suppressedValues = 0;
  emailFreq.forEach((n) => { if (n > MAX_BLOCK) suppressedValues++; });
  phoneFreq.forEach((n) => { if (n > MAX_BLOCK) suppressedValues++; });
  rows.forEach((r) => {
    r.emails = r.emails.filter((e) => (emailFreq.get(e) || 0) <= MAX_BLOCK);
    r.phones = r.phones.filter((p) => (phoneFreq.get(p) || 0) <= MAX_BLOCK);
  });

  const buckets = new Map();
  const add = (key, i) => { if (!key) return; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(i); };
  rows.forEach((r) => {
    r.emails.forEach((e) => add('e:' + e, r.i));
    r.phones.forEach((p) => add('p:' + p, r.i));
    if (r.nLast && r.nBirth) add('lb:' + r.nLast + '|' + r.nBirth, r.i);
    if (r.nLast && r.nFirst) add('lf:' + r.nLast + '|' + r.nFirst, r.i);
    if (r.nLast && r.nPostal) add('lp:' + r.nLast + '|' + r.nPostal, r.i);
  });

  const rank = { Low: 0, Medium: 1, High: 2 };
  const minRank = rank[minLevel] ?? 2;
  const seen = new Set();
  const pairs = [];
  let suppressedBuckets = 0;
  for (const idxs of buckets.values()) {
    if (idxs.length < 2) continue;
    if (idxs.length > MAX_BLOCK) { suppressedBuckets++; continue; }
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const i = idxs[x], j = idxs[y];
        const key = i < j ? i + '-' + j : j + '-' + i;
        if (seen.has(key)) continue;
        seen.add(key);
        const res = scorePair(rows[i], rows[j]);
        if ((rank[res.level] ?? 0) < minRank) continue;
        const [older, newer] = String(rows[i].created).localeCompare(String(rows[j].created)) <= 0 ? [rows[i], rows[j]] : [rows[j], rows[i]];
        pairs.push({ older, newer, ...res });
      }
    }
  }
  pairs.sort((a, b) => (rank[b.level] - rank[a.level]) || (b.score - a.score));
  return { pairs, suppressedValues, suppressedBuckets };
}

/* ─── Rendering ─────────────────────────────────────────────────────────────*/
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function fmtDate(s) { if (!s) return '-'; const d = new Date(s); return isNaN(d) ? esc(s) : `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`; }
function candidateLink(id) { return id == null ? null : APP_BASE + CANDIDATE_URL_PATH.replace('{id}', encodeURIComponent(id)); }

const FIELD_LABEL = { email: 'Same e-mail', phone: 'Same phone', birth: 'Same birth date', lastName: 'Same last name', firstName: 'Same first name', initials: 'Same initials', postal: 'Same postal code' };

function personCol(p, side) {
  const link = candidateLink(p.id);
  const nameInner = `${p.firstName ? esc(p.firstName) + ' ' : ''}${p.prefix ? esc(p.prefix) + ' ' : ''}${esc(p.lastName) || '(no name)'}`;
  const name = link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${nameInner}</a>` : nameInner;
  return `
    <div class="col">
      <div class="tag ${side === 'older' ? 'old' : 'new'}">${side === 'older' ? 'Oldest' : 'Newest'}</div>
      <div class="name">${name}</div>
      <dl>
        <dt>E-mail</dt><dd>${p.emails.length ? p.emails.map(esc).join('<br>') : '-'}</dd>
        <dt>Phone</dt><dd>${p.phones.length ? p.phones.map(esc).join('<br>') : '-'}</dd>
        <dt>Birth date</dt><dd>${fmtDate(p.birth)}</dd>
        <dt>Initials</dt><dd>${esc(p.initials) || '-'}</dd>
        <dt>Postal</dt><dd>${esc([p.postal, p.city].filter(Boolean).join(' ')) || '-'}</dd>
        <dt>Status</dt><dd>${esc(p.status) || '-'}</dd>
        <dt>Created</dt><dd>${fmtDate(p.created)}</dd>
        <dt>ID</dt><dd>#${esc(p.id)}</dd>
      </dl>
      ${link ? `<a class="open" href="${esc(link)}" target="_blank" rel="noopener">Open in Carerix &#8599;</a>` : ''}
    </div>`;
}

function renderResultsFragment(pairs, stats) {
  const levelClass = { High: 'lv-high', Medium: 'lv-med', Low: 'lv-low' };
  const pairsHtml = pairs.map((pr) => {
    const chips = pr.fields.map((f) => `<span class="chip">${FIELD_LABEL[f] || f}</span>`).join('');
    return `
      <div class="pair">
        <div class="pair-head">
          <span class="level ${levelClass[pr.level]}">${pr.level} match</span>
          <span class="chips">${chips}</span>
        </div>
        <div class="cols">${personCol(pr.older, 'older')}${personCol(pr.newer, 'newer')}</div>
      </div>`;
  }).join('') || '<div class="empty">No likely duplicate pairs found.</div>';

  const notes = [];
  if (stats.cappedPairs) notes.push(`Reached the limit of ${MAX_PAIRS} duplicate pairs (${stats.totalFound} found in the scanned set). Merge or archive some, then Refresh.`);
  if (stats.timedOut) notes.push(`Stopped at the time limit after scanning ${stats.scanned} candidates — press Refresh to keep scanning, or narrow the scope.`);
  if (stats.suppressedValues || stats.suppressedBuckets) notes.push(`Ignored ${stats.suppressedValues} shared e-mail/phone value(s) and ${stats.suppressedBuckets} oversized group(s) — shared by more than ${MAX_BLOCK} candidates, treated as placeholders to avoid false matches.`);
  const note = notes.length ? `<p class="note">${notes.map(esc).join('<br>')}</p>` : '';

  return `
    <div class="toolbar">
      <button class="btn" onclick="location.reload()">&#8635; Refresh / opnieuw zoeken</button>
      <span class="toolbar-hint">Run again after merging or archiving candidates.</span>
    </div>
    <div class="summary-bar">
      <div class="stat"><div class="num">${pairs.length}</div><div class="lbl">candidate pairs</div></div>
      <div class="stat"><div class="num">${pairs.filter((p) => p.level === 'High').length}</div><div class="lbl">high confidence</div></div>
      <div class="stat"><div class="num">${stats.scanned}</div><div class="lbl">candidates scanned</div></div>
    </div>
    ${note}
    <div class="searchbar"><input type="search" id="q" placeholder="Search name, e-mail, phone or ID..." autocomplete="off"/><span id="qc"></span></div>
    <div id="results">${pairsHtml}</div>`;
}

const PAGE_STYLES = `
  :root { --cx-accent:#2f6fb2; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:#24292f; background:#f6f8fa; margin:0; padding:24px; }
  h1 { color:var(--cx-accent); font-size:22px; margin:0 0 4px; }
  .subtitle { color:#57606a; margin:0 0 18px; font-size:13px; }
  .note { background:#fff8c5; border:1px solid #eac54f; border-radius:8px; padding:10px 14px; font-size:13px; color:#57606a; margin:0 0 16px; }
  .toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin:0 0 16px; }
  .btn { background:var(--cx-accent); color:#fff; border:none; border-radius:8px; padding:9px 16px; font-size:14px; cursor:pointer; }
  .btn:hover { background:#255a91; }
  .toolbar-hint { font-size:12px; color:#8c959f; }
  .summary-bar { display:flex; gap:12px; flex-wrap:wrap; margin:0 0 20px; }
  .stat { background:#fff; border:1px solid #d0d7de; border-radius:8px; padding:12px 16px; min-width:150px; }
  .stat .num { font-size:26px; font-weight:700; color:var(--cx-accent); line-height:1; }
  .stat .lbl { font-size:12px; color:#57606a; margin-top:4px; }
  .searchbar { margin:0 0 20px; }
  .searchbar input { width:100%; max-width:420px; padding:8px 12px; border:1px solid #d0d7de; border-radius:6px; font-size:14px; }
  .searchbar span { margin-left:10px; color:#57606a; font-size:13px; }
  .pair { background:#fff; border:1px solid #d0d7de; border-radius:8px; margin:0 0 16px; overflow:hidden; }
  .pair-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 14px; border-bottom:1px solid #eaeef2; background:#fafbfc; }
  .level { font-size:12px; font-weight:700; padding:3px 10px; border-radius:12px; white-space:nowrap; }
  .lv-high { background:#ffebe9; color:#cf222e; }
  .lv-med { background:#fff8c5; color:#9a6700; }
  .lv-low { background:#eef1f4; color:#57606a; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip { font-size:12px; background:#ddf4ff; color:#0969da; border:1px solid #b6e3ff; border-radius:10px; padding:2px 8px; }
  .cols { display:flex; }
  .col { flex:1 1 50%; min-width:240px; padding:12px 14px; }
  .col:first-child { border-right:1px solid #eaeef2; }
  .tag { display:inline-block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding:2px 8px; border-radius:10px; margin-bottom:8px; }
  .tag.old { background:#eef1f4; color:#57606a; }
  .tag.new { background:#dafbe1; color:#1a7f37; }
  .name { font-size:15px; font-weight:600; margin-bottom:8px; }
  .name a { color:var(--cx-accent); text-decoration:none; }
  .open { display:inline-block; margin-top:10px; background:var(--cx-accent); color:#fff; text-decoration:none; padding:5px 12px; border-radius:6px; font-size:13px; }
  dl { margin:0; display:grid; grid-template-columns:74px 1fr; gap:4px 8px; font-size:13px; }
  dt { color:#8c959f; }
  dd { margin:0; word-break:break-word; }
  .empty { background:#fff; border:1px dashed #d0d7de; border-radius:8px; padding:24px; text-align:center; color:#57606a; }
  .loader { max-width:560px; margin:8px 0 24px; }
  .lbar { background:#eaeef2; border-radius:8px; height:16px; overflow:hidden; }
  .lfill { height:100%; width:0; background:var(--cx-accent); border-radius:8px; transition:width .3s ease; }
  .lfill.indet { width:100%; background:linear-gradient(90deg,#e6eef7 25%,#2f6fb2 50%,#e6eef7 75%); background-size:200% 100%; animation:indet 1.2s linear infinite; }
  @keyframes indet { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
  .lstatus { margin-top:10px; font-size:14px; color:#24292f; }
  .lsteps { margin-top:6px; font-size:12px; color:#8c959f; }
  .lsteps .on { color:var(--cx-accent); font-weight:600; }
  @media print { body { background:#fff; padding:0; } .searchbar,.loader { display:none; } .pair { break-inside:avoid; } }`;

const LOADER_JS = `
(function(){
  var fill=document.getElementById('fill'), st=document.getElementById('lstatus');
  var s1=document.getElementById('s1'), s2=document.getElementById('s2'), done=false;
  var params=new URLSearchParams(window.location.search); params.set('stream','1');
  var es=new EventSource('/api/duplicates?'+params.toString());
  function setFill(p){ fill.className='lfill'; fill.style.width=p+'%'; }
  function setIndet(){ if(fill.className.indexOf('indet')<0){ fill.className='lfill indet'; } }
  es.addEventListener('progress',function(e){
    var d=JSON.parse(e.data);
    if(d.phase==='fetch'){
      var base;
      if(d.total){ var p=Math.min(99,Math.round(d.fetched/d.total*100)); setFill(p);
        base=d.fetched.toLocaleString()+' / '+d.total.toLocaleString()+' kandidaten ('+p+'%)'; }
      else { setIndet(); base=d.fetched.toLocaleString()+' kandidaten opgehaald…'; }
      if(d.pairs){ base+=' · '+d.pairs.toLocaleString()+' duplicaten gevonden'; }
      st.textContent=base;
    } else if(d.phase==='compute'){
      if(s1)s1.className=''; if(s2)s2.className='on'; setFill(99); st.textContent='Duplicaten berekenen…';
    }
  });
  es.addEventListener('done',function(e){
    done=true; es.close(); var d=JSON.parse(e.data); setFill(100);
    document.getElementById('app').innerHTML=d.fragment;
    var ld=document.getElementById('loader'); if(ld&&ld.parentNode)ld.parentNode.removeChild(ld);
    initSearch();
  });
  es.addEventListener('fail',function(e){
    done=true; es.close(); var d=JSON.parse(e.data);
    st.textContent='Fout: '+(d.message||'onbekend'); fill.className='lfill'; fill.style.width='100%'; fill.style.background='#d1242f';
  });
  es.onerror=function(){ if(done)return; es.close(); st.textContent='Verbinding onderbroken — vernieuw de pagina om opnieuw te proberen.'; };
  function initSearch(){
    var box=document.getElementById('q'), info=document.getElementById('qc'), it=document.querySelectorAll('.pair');
    if(!box)return;
    box.addEventListener('input',function(){
      var q=box.value.toLowerCase().trim(),shown=0;
      for(var i=0;i<it.length;i++){var hit=!q||it[i].textContent.toLowerCase().indexOf(q)>=0;it[i].style.display=hit?'':'none';if(hit)shown++;}
      info.textContent=q?(shown+' pair'+(shown===1?'':'s')+' shown'):'';
    });
  }
})();`;

function renderLoaderPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Duplicate Candidates</title>
<style>${PAGE_STYLES}</style></head><body>
  <h1>Duplicate Candidates</h1>
  <p class="subtitle">High-confidence one-on-one matches &middot; oldest on the left, newest on the right &middot; add <code>?min=medium</code> for weaker matches</p>
  <div id="loader" class="loader">
    <div class="lbar"><div id="fill" class="lfill"></div></div>
    <div id="lstatus" class="lstatus">Verbinden met Carerix…</div>
    <div class="lsteps"><span id="s1" class="on">1. Kandidaten ophalen</span> &nbsp;&rarr;&nbsp; <span id="s2">2. Duplicaten berekenen</span></div>
  </div>
  <div id="app"></div>
  <script>${LOADER_JS}</script>
</body></html>`;
}

function renderError(err, extra) {
  const gqlBlock = err.graphqlErrors ? `<pre>${esc(JSON.stringify(err.graphqlErrors, null, 2))}</pre>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Error</title>
<style>body{font-family:-apple-system,Arial,sans-serif;padding:24px;color:#24292f}pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:14px;overflow:auto;font-size:13px}h1{color:#d1242f;font-size:20px}</style>
</head><body><h1>Could not build the dashboard</h1><p>${esc(err.message)}</p>${gqlBlock}${extra || ''}</body></html>`;
}

/* ─── Handler ───────────────────────────────────────────────────────────────*/
export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
  const q = (k) => req.query?.[k] || url.searchParams.get(k);
  const debug = q('debug');
  const stream = q('stream');
  const scope = q('scope');
  const ownerId = q('ownerId');
  const minRaw = (q('min') || 'high').toLowerCase();
  const min = minRaw === 'low' ? 'Low' : minRaw === 'medium' ? 'Medium' : 'High';

  // deleted = merged/removed; anonymized = GDPR-removed. Both excluded.
  let qualifier = 'deleted = 0 and anonymized = 0';
  if (scope === 'owner' && ownerId) qualifier += ` and ownerID = ${Number(ownerId)}`;

  // Debug modes → JSON
  if (debug) {
    try {
      const token = await getAccessToken();
      let out;
      if (debug === 'schema') out = await introspect(token);
      else if (debug === 'probe') out = await probeAll(token);
      else if (debug === 'raw') out = (await fetchCandidates(token, qualifier, 1)).slice(0, 1);
      else out = { error: 'unknown debug mode' };
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify(out, null, 2));
    } catch (err) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(500).send(JSON.stringify({ error: err.message, graphqlErrors: err.graphqlErrors }, null, 2));
    }
  }

  // SSE stream → progress events + final results fragment
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write('event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n');
    try {
      const token = await getAccessToken();
      const total = await detectTotal(token, qualifier);
      send('progress', { phase: 'fetch', fetched: 0, total, pairs: 0 });
      let all = [], page = 0, timedOut = false, pairsCount = 0;
      const start = Date.now();
      while (true) {
        const items = await fetchPage(token, qualifier, page);
        all = all.concat(items);
        const noMore = items.length < PAGE_SIZE;
        // Recompute duplicates periodically (and at the end) to allow early stop
        if (noMore || page % 10 === 9) pairsCount = findPairs(all.map(toRow), min).pairs.length;
        send('progress', { phase: 'fetch', fetched: all.length, total, pairs: pairsCount });
        if (noMore) break;                                   // no more candidates
        if (pairsCount >= MAX_PAIRS) break;                  // enough duplicates found
        if (all.length >= MAX_SCAN) break;                   // safety cap
        if (Date.now() - start > TIME_BUDGET_MS) { timedOut = true; break; } // time budget
        page++;
      }
      send('progress', { phase: 'compute', fetched: all.length, total });
      const result = findPairs(all.map(toRow), min);
      const cappedPairs = result.pairs.length > MAX_PAIRS;
      const pairs = result.pairs.slice(0, MAX_PAIRS);
      const fragment = renderResultsFragment(pairs, {
        scanned: all.length,
        suppressedValues: result.suppressedValues,
        suppressedBuckets: result.suppressedBuckets,
        cappedPairs, timedOut, totalFound: result.pairs.length,
      });
      send('done', { fragment });
      return res.end();
    } catch (err) {
      send('fail', { message: err.message });
      return res.end();
    }
  }

  // Default → loader page (static, instant)
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(renderLoaderPage());
}
