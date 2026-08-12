/**
 * Vercel Serverless Function — Duplicate Candidates dashboard
 *
 * Queries the Carerix GraphQL API for candidates (CREmployee), groups them by
 * normalized e-mail address and/or phone number, and renders an HTML dashboard
 * where each duplicate cluster is shown OLDEST (left) -> NEWEST (right).
 *
 * Reuses the OAuth2 + GraphQL pagination pattern from api/rss.js / server.js.
 *
 * Modes (query string):
 *   /api/duplicates                 → the dashboard
 *   /api/duplicates?debug=schema    → introspect the live schema (employee/user
 *                                     types + employee-related root queries).
 *                                     RUN THIS FIRST to confirm field names.
 *   /api/duplicates?debug=raw       → fetch 1 candidate with the configured
 *                                     fields and dump the raw JSON.
 *   /api/duplicates?scope=owner&ownerId=123  → limit to one owner (optional)
 *
 * Env vars (same as the RSS feed):
 *   CARERIX_CLIENT_ID, CARERIX_CLIENT_SECRET, CARERIX_TOKEN_ENDPOINT
 *   CARERIX_APP_BASE  (optional) e.g. https://yourcompany.carerix.com
 *                     If set, each candidate gets an "Open" deep link.
 */

const CARERIX_GRAPHQL_URI = 'https://api.carerix.io/graphql/v1/graphql';
const PAGE_SIZE = 500;

/* ============================================================================
 * CONFIG — the ONLY place you edit after seeing ?debug=schema output.
 * ==========================================================================*/
const CONFIG = {
  // Root query that lists candidates. Confirm via ?debug=schema.
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
      mobileNumber
      mobileNumberBusiness
      phoneNumber
      birthDate
    }
  `,

  // Extractors — map a returned item to values. Adjust if you change fields.
  getId:        (c) => c.employeeID ?? c._id,
  getFirstName: (c) => c.firstName,
  getPrefix:    (c) => c.lastNamePrefix,
  getLastName:  (c) => c.lastName,
  getEmails:    (c) => [c.emailAddress, c.businessEmailAddress],
  getPhones:    (c) => [c.toUser?.mobileNumber, c.toUser?.mobileNumberBusiness, c.toUser?.phoneNumber],
  getBirth:     (c) => c.toUser?.birthDate,
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
    const msg = json.errors.map((e) => e.message).join(' | ');
    const err = new Error(`GraphQL errors: ${msg}`);
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
  const relevantRoot = allRoot.filter((n) => /mploye|andidate|user/i.test(n));
  const typeName = (t) => t?.name ? { name: t.name, kind: t.kind } : null;
  const flatten = (t) => t && ({
    name: t.name,
    fields: (t.fields || []).map((f) => ({
      name: f.name,
      type: f.type?.name || f.type?.ofType?.name || f.type?.ofType?.ofType?.name || f.type?.kind,
    })),
  });
  return {
    employeeRootQueries: relevantRoot,
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
function normEmail(e) {
  if (!e) return '';
  const s = String(e).trim().toLowerCase();
  return s.includes('@') ? s : '';
}
function normPhone(p) {
  if (!p) return '';
  let d = String(p).replace(/[^\d+]/g, '');
  d = d.replace(/^00/, '').replace(/^\+/, '');
  if (d.charAt(0) === '0') d = '31' + d.substring(1); // NL: 06.. -> 316..
  return d.length >= 6 ? d : '';
}

/* ─── Union-Find (link candidates sharing an e-mail OR a phone) ─────────────*/
class UF {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; } return r; }
  union(a, b) { this.p.set(this.find(a), this.find(b)); }
}

function buildClusters(candidates) {
  // Normalize + index
  const rows = candidates.map((c, i) => {
    const emails = [...new Set(CONFIG.getEmails(c).map(normEmail).filter(Boolean))];
    const phones = [...new Set(CONFIG.getPhones(c).map(normPhone).filter(Boolean))];
    return {
      i,
      id: CONFIG.getId(c),
      firstName: CONFIG.getFirstName(c) || '',
      prefix: CONFIG.getPrefix(c) || '',
      lastName: CONFIG.getLastName(c) || '',
      birth: CONFIG.getBirth(c) || '',
      created: CONFIG.getCreated(c) || '',
      emails, phones,
      email: emails[0] || '',
      phone: phones[0] || '',
    };
  });

  // Link rows that share a normalized e-mail or phone
  const uf = new UF();
  const byEmail = new Map();
  const byPhone = new Map();
  for (const r of rows) {
    uf.find(r.i);
    for (const e of r.emails) { if (byEmail.has(e)) uf.union(byEmail.get(e), r.i); else byEmail.set(e, r.i); }
    for (const p of r.phones) { if (byPhone.has(p)) uf.union(byPhone.get(p), r.i); else byPhone.set(p, r.i); }
  }

  // Group by component, keep only clusters with >1 member
  const comps = new Map();
  for (const r of rows) { const root = uf.find(r.i); if (!comps.has(root)) comps.set(root, []); comps.get(root).push(r); }

  const clusters = [];
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => String(a.created).localeCompare(String(b.created))); // oldest first
    const emails = [...new Set(members.flatMap((m) => m.emails))];
    const phones = [...new Set(members.flatMap((m) => m.phones))];
    clusters.push({ members, emails, phones });
  }
  // Biggest clusters first
  clusters.sort((a, b) => b.members.length - a.members.length);
  return clusters;
}

/* ─── HTML rendering ────────────────────────────────────────────────────────*/
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function fmtDate(s) { if (!s) return '-'; const d = new Date(s); return isNaN(d) ? esc(s) : `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`; }

function candidateLink(id) {
  const base = process.env.CARERIX_APP_BASE;
  if (!base || id == null) return null;
  // Best-effort deep link into the Carerix web app. Adjust path if needed.
  return `${base.replace(/\/$/, '')}/main?searchEntityName=CREmployee&id=${encodeURIComponent(id)}`;
}

function renderDashboard(clusters, stats) {
  const cardsHtml = (cluster) => cluster.members.map((m, idx) => {
    const link = candidateLink(m.id);
    const nameInner = `${m.firstName ? esc(m.firstName) + ' ' : ''}${m.prefix ? esc(m.prefix) + ' ' : ''}${esc(m.lastName) || '(no name)'}`;
    const nameHtml = link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${nameInner}</a>` : nameInner;
    const tag = idx === 0 ? '<span class="tag old">Oldest</span>' : (idx === cluster.members.length - 1 ? '<span class="tag new">Newest</span>' : '');
    return `
      <div class="card">
        <div>${tag}</div>
        <div class="name">${nameHtml}</div>
        <dl>
          <dt>E-mail</dt><dd>${m.emails.length ? m.emails.map(esc).join('<br>') : '-'}</dd>
          <dt>Phone</dt><dd>${m.phones.length ? m.phones.map(esc).join('<br>') : '-'}</dd>
          <dt>Birth date</dt><dd>${fmtDate(m.birth)}</dd>
          <dt>Created</dt><dd>${fmtDate(m.created)}</dd>
          <dt>ID</dt><dd>#${esc(m.id)}</dd>
        </dl>
      </div>`;
  }).join('');

  const clustersHtml = clusters.map((cluster) => {
    const keyLabel = [...cluster.emails, ...cluster.phones].map(esc).join(' &middot; ') || '(linked)';
    return `
      <div class="cluster">
        <div class="cluster-head">
          <span class="key">${keyLabel}</span>
          <span class="badge">${cluster.members.length} candidates</span>
        </div>
        <div class="cards">${cardsHtml(cluster)}</div>
      </div>`;
  }).join('') || '<div class="empty">No possible duplicates found (by e-mail or phone).</div>';

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
  .cluster { background:#fff; border:1px solid #d0d7de; border-radius:8px; margin:0 0 16px; overflow:hidden; }
  .cluster-head { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 14px; background:#fff5f5; border-bottom:1px solid #f1c6c6; }
  .cluster-head .key { font-weight:600; word-break:break-all; }
  .cluster-head .badge { background:#d1242f; color:#fff; border-radius:12px; font-size:12px; padding:2px 10px; white-space:nowrap; }
  .cards { display:flex; gap:0; overflow-x:auto; }
  .card { flex:1 0 240px; min-width:240px; border-right:1px solid #eaeef2; padding:12px 14px; }
  .card:last-child { border-right:none; }
  .card .tag { display:inline-block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding:2px 8px; border-radius:10px; margin-bottom:8px; }
  .card .tag.old { background:#eef1f4; color:#57606a; }
  .card .tag.new { background:#dafbe1; color:#1a7f37; }
  .card .name { font-size:15px; font-weight:600; margin-bottom:8px; }
  .card .name a { color:var(--cx-accent); text-decoration:none; }
  .card dl { margin:0; display:grid; grid-template-columns:78px 1fr; gap:4px 8px; font-size:13px; }
  .card dt { color:#8c959f; }
  .card dd { margin:0; word-break:break-word; }
  .empty { background:#fff; border:1px dashed #d0d7de; border-radius:8px; padding:24px; text-align:center; color:#57606a; }
  @media print { body { background:#fff; padding:0; } .searchbar { display:none; } .cluster { break-inside:avoid; } }
</style></head><body>
  <h1>Duplicate Candidates</h1>
  <p class="subtitle">Grouped by e-mail address and/or phone number &middot; oldest on the left, newest on the right</p>
  <div class="summary-bar">
    <div class="stat"><div class="num">${clusters.length}</div><div class="lbl">duplicate groups</div></div>
    <div class="stat"><div class="num">${stats.scanned}</div><div class="lbl">candidates scanned</div></div>
    <div class="stat"><div class="num">${stats.dupCandidates}</div><div class="lbl">candidates in a group</div></div>
  </div>
  <div class="searchbar">
    <input type="search" id="q" placeholder="Search name, e-mail, phone or ID..." autocomplete="off"/>
    <span id="qc"></span>
  </div>
  <div id="results">${clustersHtml}</div>
  <script>
    (function(){
      var box=document.getElementById('q'),info=document.getElementById('qc'),cl=document.querySelectorAll('.cluster');
      if(!box)return;
      box.addEventListener('input',function(){
        var q=box.value.toLowerCase().trim(),shown=0;
        for(var i=0;i<cl.length;i++){var hit=!q||cl[i].textContent.toLowerCase().indexOf(q)>=0;cl[i].style.display=hit?'':'none';if(hit)shown++;}
        info.textContent=q?(shown+' group'+(shown===1?'':'s')+' shown'):'';
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
  const debug = req.query?.debug || url.searchParams.get('debug');
  const scope = req.query?.scope || url.searchParams.get('scope');
  const ownerId = req.query?.ownerId || url.searchParams.get('ownerId');

  try {
    const token = await getAccessToken();

    if (debug === 'schema') {
      const schema = await introspect(token);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify(schema, null, 2));
    }

    if (debug === 'raw') {
      const one = await fetchCandidates(token, 'deleted=0', 1);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify(one.slice(0, 1), null, 2));
    }

    let qualifier = 'deleted=0';
    if (scope === 'owner' && ownerId) qualifier += ` and toUser.owner.userID = ${Number(ownerId)}`;

    const candidates = await fetchCandidates(token, qualifier);
    const clusters = buildClusters(candidates);
    const dupCandidates = clusters.reduce((n, c) => n + c.members.length, 0);

    const html = renderDashboard(clusters, { scanned: candidates.length, dupCandidates });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(html);
  } catch (err) {
    // If the main query failed, try to attach live schema info to speed up the fix.
    let extra = '';
    if (debug !== 'schema') {
      try {
        const token = await getAccessToken();
        const schema = await introspect(token);
        extra = `<h2>Live schema (candidate/user types)</h2><pre>${esc(JSON.stringify(schema, null, 2))}</pre>`;
      } catch { /* ignore */ }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(renderError(err, extra));
  }
}
