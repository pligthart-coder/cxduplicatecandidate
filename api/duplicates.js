/**
 * Vercel Serverless Function — Smart Duplicate Candidate checker
 *
 * Queries the Carerix GraphQL API for candidates (CREmployee) and finds likely
 * duplicate PAIRS (one-on-one) by comparing multiple fields and scoring each
 * pair with a confidence level. Each pair is shown side by side, oldest on the
 * left and newest on the right, with chips explaining WHY they match.
 *
 * Compared fields: e-mail(s), phone(s), birth date, last name, first name,
 *                  initials, postal code.
 *
 * Modes (query string):
 *   /api/duplicates                 → the dashboard (pairs)
 *   /api/duplicates?debug=schema    → introspect the live schema (RUN FIRST)
 *   /api/duplicates?debug=raw       → dump 1 candidate record
 *   /api/duplicates?min=medium|high → minimum confidence to show (default medium)
 *   /api/duplicates?scope=owner&ownerId=123  → limit to one owner (optional)
 *
 * Env vars: CARERIX_CLIENT_ID, CARERIX_CLIENT_SECRET, CARERIX_TOKEN_ENDPOINT
 *           CARERIX_APP_BASE (optional) for "Open candidate" deep links.
 */

const CARERIX_GRAPHQL_URI = 'https://api.carerix.io/graphql/v1/graphql';
const PAGE_SIZE = 500;

/* ============================================================================
 * CONFIG — the ONLY place you edit after seeing ?debug=schema output.
 * ==========================================================================*/
const CONFIG = {
  queryName: 'crEmployeePage',

  // GraphQL selection set per candidate. Edit field names to match your schema.
  itemSelection: `
    _id
    employeeID
    creationDate
    firstName
    lastNamePrefix
    lastName
    emailAddress
    businessEmailAddress
    toUser {
      initials
      birthDate
      mobileNumber
      mobileNumberBusiness
      phoneNumber
      homePostalCode
      homeCity
    }
  `,

  // Extractors — map a returned item to values. Adjust if you change fields.
  getId:        (c) => c.employeeID ?? c._id,
  getFirstName: (c) => c.firstName,
  getPrefix:    (c) => c.lastNamePrefix,
  getLastName:  (c) => c.lastName,
  getInitials:  (c) => c.toUser?.initials,
  getEmails:    (c) => [c.emailAddress, c.businessEmailAddress],
  getPhones:    (c) => [c.toUser?.mobileNumber, c.toUser?.mobileNumberBusiness, c.toUser?.phoneNumber],
  getBirth:     (c) => c.toUser?.birthDate,
  getPostal:    (c) => c.toUser?.homePostalCode,
  getCity:      (c) => c.toUser?.homeCity,
  getCreated:   (c) => c.creationDate,
};

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
  try { json = JSON.parse(text); } catch { throw new Error(`Non-JSON response ${res.status}: ${text.slice(0, 500)}`); }
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 800)}`);
  if (json.errors) {
    const err = new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(' | ')}`);
    err.graphqlErrors = json.errors;
    throw err;
  }
  return json.data;
}

/* ─── Introspection (schema discovery) ──────────────────────────────────────*/
async function introspect(token) {
  const query = `
    query Introspect {
      schema: __schema { queryType { fields { name } } }
      CREmployee: __type(name:"CREmployee"){ ...TF }
      Employee:   __type(name:"Employee"){ ...TF }
      CRCandidate:__type(name:"CRCandidate"){ ...TF }
      CRUser:     __type(name:"CRUser"){ ...TF }
      User:       __type(name:"User"){ ...TF }
    }
    fragment TF on __Type {
      name kind
      fields { name type { name kind ofType { name kind ofType { name kind } } } }
    }`;
  const data = await gql(token, query, {});
  const allRoot = (data.schema?.queryType?.fields || []).map((f) => f.name);
  const flatten = (t) => t && ({
    name: t.name,
    fields: (t.fields || []).map((f) => ({
      name: f.name,
      type: f.type?.name || f.type?.ofType?.name || f.type?.ofType?.ofType?.name || f.type?.kind,
    })),
  });
  return {
    employeeRootQueries: allRoot.filter((n) => /mploye|andidate|user/i.test(n)),
    types: {
      CREmployee: flatten(data.CREmployee),
      Employee: flatten(data.Employee),
      CRCandidate: flatten(data.CRCandidate),
      CRUser: flatten(data.CRUser),
      User: flatten(data.User),
    },
  };
}

/* ─── Fetch all candidates ──────────────────────────────────────────────────*/
async function fetchCandidates(token, qualifier, limitPages) {
  const query = `
    query ($qualifier: String, $pageable: Pageable) {
      ${CONFIG.queryName}(qualifier: $qualifier, pageable: $pageable) {
        items { ${CONFIG.itemSelection} }
      }
    }`;
  let all = [];
  let page = 0;
  while (true) {
    const data = await gql(token, query, { qualifier, pageable: { page, size: PAGE_SIZE } });
    const items = data?.[CONFIG.queryName]?.items || [];
    all = all.concat(items);
    if (items.length < PAGE_SIZE) break;
    page++;
    if (limitPages && page >= limitPages) break;
  }
  return all;
}

/* ─── Normalization ─────────────────────────────────────────────────────────*/
function stripDiacritics(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ""); }
function normEmail(e) { if (!e) return ''; const s = String(e).trim().toLowerCase(); return s.includes('@') ? s : ''; }
function normPhone(p) {
  if (!p) return '';
  let d = String(p).replace(/[^\d+]/g, '').replace(/^00/, '').replace(/^\+/, '');
  if (d.charAt(0) === '0') d = '31' + d.substring(1); // NL: 06.. -> 316..
  return d.length >= 6 ? d : '';
}
function normName(s) { return s ? stripDiacritics(String(s).toLowerCase()).replace(/[^a-z0-9]/g, '') : ''; }
function normPostal(s) { return s ? String(s).toUpperCase().replace(/\s+/g, '') : ''; }
function normBirth(s) { if (!s) return ''; const d = new Date(s); return isNaN(d) ? String(s).slice(0, 10) : d.toISOString().slice(0, 10); }

/* ─── Build normalized rows ────────────────────────────────────────────────*/
function toRow(c, i) {
  const emails = [...new Set(CONFIG.getEmails(c).map(normEmail).filter(Boolean))];
  const phones = [...new Set(CONFIG.getPhones(c).map(normPhone).filter(Boolean))];
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
    created: CONFIG.getCreated(c) || '',
    emails, phones,
    // normalized keys
    nFirst: normName(CONFIG.getFirstName(c)),
    nLast: normName(CONFIG.getLastName(c)),
    nInitials: normName(CONFIG.getInitials(c)),
    nBirth: normBirth(CONFIG.getBirth(c)),
    nPostal: normPostal(CONFIG.getPostal(c)),
  };
}

/* ─── Score a pair ─────────────────────────────────────────────────────────
 * Returns { score, fields[], level } — level is High / Medium / Low.
 * ==========================================================================*/
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
  if (has('email') ||
      (has('phone') && (has('lastName') || has('firstName'))) ||
      (has('lastName') && has('firstName') && has('birth'))) {
    level = 'High';
  } else if (has('phone') ||
      (has('lastName') && has('firstName')) ||
      (has('lastName') && has('birth'))) {
    level = 'Medium';
  }
  return { score, fields, level };
}

/* ─── Find duplicate pairs via blocking (avoids O(n^2)) ────────────────────*/
function findPairs(rows, minLevel) {
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
  const minRank = rank[minLevel] ?? 1;
  const seen = new Set();
  const pairs = [];

  for (const idxs of buckets.values()) {
    if (idxs.length < 2) continue;
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const i = idxs[x], j = idxs[y];
        const key = i < j ? i + '-' + j : j + '-' + i;
        if (seen.has(key)) continue;
        seen.add(key);
        const res = scorePair(rows[i], rows[j]);
        if ((rank[res.level] ?? 0) < minRank) continue;
        // oldest left, newest right
        const [older, newer] = String(rows[i].created).localeCompare(String(rows[j].created)) <= 0
          ? [rows[i], rows[j]] : [rows[j], rows[i]];
        pairs.push({ older, newer, ...res });
      }
    }
  }

  pairs.sort((a, b) => (rank[b.level] - rank[a.level]) || (b.score - a.score));
  return pairs;
}

/* ─── HTML rendering ────────────────────────────────────────────────────────*/
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function fmtDate(s) { if (!s) return '-'; const d = new Date(s); return isNaN(d) ? esc(s) : `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`; }

function candidateLink(id) {
  const base = process.env.CARERIX_APP_BASE;
  if (!base || id == null) return null;
  return `${base.replace(/\/$/, '')}/main?searchEntityName=CREmployee&id=${encodeURIComponent(id)}`;
}

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
        <dt>Created</dt><dd>${fmtDate(p.created)}</dd>
        <dt>ID</dt><dd>#${esc(p.id)}</dd>
      </dl>
    </div>`;
}

function renderDashboard(pairs, stats) {
  const levelClass = { High: 'lv-high', Medium: 'lv-med', Low: 'lv-low' };
  const pairsHtml = pairs.map((pr) => {
    const chips = pr.fields.map((f) => `<span class="chip">${FIELD_LABEL[f] || f}</span>`).join('');
    return `
      <div class="pair">
        <div class="pair-head">
          <span class="level ${levelClass[pr.level]}">${pr.level} match</span>
          <span class="chips">${chips}</span>
        </div>
        <div class="cols">
          ${personCol(pr.older, 'older')}
          ${personCol(pr.newer, 'newer')}
        </div>
      </div>`;
  }).join('') || '<div class="empty">No likely duplicate pairs found.</div>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Duplicate Candidates</title>
<style>
  :root { --cx-accent:#2f6fb2; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:#24292f; background:#f6f8fa; margin:0; padding:24px; }
  h1 { color:var(--cx-accent); font-size:22px; margin:0 0 4px; }
  .subtitle { color:#57606a; margin:0 0 18px; font-size:13px; }
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
  dl { margin:0; display:grid; grid-template-columns:74px 1fr; gap:4px 8px; font-size:13px; }
  dt { color:#8c959f; }
  dd { margin:0; word-break:break-word; }
  .empty { background:#fff; border:1px dashed #d0d7de; border-radius:8px; padding:24px; text-align:center; color:#57606a; }
  @media print { body { background:#fff; padding:0; } .searchbar { display:none; } .pair { break-inside:avoid; } }
</style></head><body>
  <h1>Duplicate Candidates</h1>
  <p class="subtitle">One-on-one matches, scored by confidence &middot; oldest on the left, newest on the right</p>
  <div class="summary-bar">
    <div class="stat"><div class="num">${pairs.length}</div><div class="lbl">candidate pairs</div></div>
    <div class="stat"><div class="num">${pairs.filter((p) => p.level === 'High').length}</div><div class="lbl">high confidence</div></div>
    <div class="stat"><div class="num">${stats.scanned}</div><div class="lbl">candidates scanned</div></div>
  </div>
  <div class="searchbar">
    <input type="search" id="q" placeholder="Search name, e-mail, phone or ID..." autocomplete="off"/>
    <span id="qc"></span>
  </div>
  <div id="results">${pairsHtml}</div>
  <script>
    (function(){
      var box=document.getElementById('q'),info=document.getElementById('qc'),it=document.querySelectorAll('.pair');
      if(!box)return;
      box.addEventListener('input',function(){
        var q=box.value.toLowerCase().trim(),shown=0;
        for(var i=0;i<it.length;i++){var hit=!q||it[i].textContent.toLowerCase().indexOf(q)>=0;it[i].style.display=hit?'':'none';if(hit)shown++;}
        info.textContent=q?(shown+' pair'+(shown===1?'':'s')+' shown'):'';
      });
    })();
  </script>
</body></html>`;
}

function renderError(err, extra) {
  const gqlBlock = err.graphqlErrors ? `<pre>${esc(JSON.stringify(err.graphqlErrors, null, 2))}</pre>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Duplicate Candidates — error</title>
<style>body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:24px;color:#24292f}pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:8px;padding:14px;overflow:auto;font-size:13px}h1{color:#d1242f;font-size:20px}code{background:#f6f8fa;padding:1px 5px;border-radius:4px}</style>
</head><body>
  <h1>Could not build the dashboard</h1>
  <p>${esc(err.message)}</p>
  ${gqlBlock}
  <p>Most likely a field name in <code>CONFIG</code> doesn't match your schema. Run
     <code>?debug=schema</code> to see the real candidate/user fields, then adjust
     <code>CONFIG.queryName</code> / <code>CONFIG.itemSelection</code> in <code>api/duplicates.js</code>.</p>
  ${extra || ''}
</body></html>`;
}

/* ─── Handler ───────────────────────────────────────────────────────────────*/
export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers?.host || 'localhost'}`);
  const q = (k) => req.query?.[k] || url.searchParams.get(k);
  const debug = q('debug');
  const scope = q('scope');
  const ownerId = q('ownerId');
  const min = (q('min') || 'medium').toLowerCase() === 'high' ? 'High' : 'Medium';

  try {
    const token = await getAccessToken();

    if (debug === 'schema') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify(await introspect(token), null, 2));
    }
    if (debug === 'raw') {
      const one = await fetchCandidates(token, 'deleted=0', 1);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify(one.slice(0, 1), null, 2));
    }

    let qualifier = 'deleted=0';
    if (scope === 'owner' && ownerId) qualifier += ` and toUser.owner.userID = ${Number(ownerId)}`;

    const candidates = await fetchCandidates(token, qualifier);
    const rows = candidates.map(toRow);
    const pairs = findPairs(rows, min);

    const html = renderDashboard(pairs, { scanned: candidates.length });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(html);
  } catch (err) {
    let extra = '';
    if (debug !== 'schema') {
      try { extra = `<h2>Live schema (candidate/user types)</h2><pre>${esc(JSON.stringify(await introspect(await getAccessToken()), null, 2))}</pre>`; } catch { /* ignore */ }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(renderError(err, extra));
  }
}
