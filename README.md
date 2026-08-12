# Carerix — Duplicate Candidates dashboard

Finds possible **duplicate candidates** in Carerix and shows them in an HTML
dashboard: each duplicate group stacked, with the **oldest candidate on the
left** and the **newest on the right**. Candidates are grouped by normalized
**e-mail address and/or phone number** (linked via union-find, so sharing
either one puts them in the same group). Includes a live front-end search box.

It talks to the **Carerix GraphQL API** (`api.carerix.io/graphql/v1/graphql`)
using OAuth2 client credentials — the same auth the Carerix RSS feed uses.

## Endpoints

| URL | What it does |
|---|---|
| `/api/duplicates` | The dashboard |
| `/api/duplicates?debug=schema` | Introspect the live schema (candidate/user types + employee-related root queries). **Run this first** to confirm field names. |
| `/api/duplicates?debug=raw` | Fetch one candidate with the configured fields and dump the raw JSON |
| `/api/duplicates?scope=owner&ownerId=123` | Limit to one owner (optional) |

If a GraphQL query fails, the page shows the exact GraphQL error **plus** the
live schema, so field-name mismatches are easy to fix.

## Setup

1. **Environment variables** (Vercel project settings, or a local `.env`):
   ```
   CARERIX_CLIENT_ID=...
   CARERIX_CLIENT_SECRET=...
   CARERIX_TOKEN_ENDPOINT=https://yourcompany.carerix.com/cxoauth2/token
   CARERIX_APP_BASE=https://yourcompany.carerix.com   # optional, for "Open" deep links
   ```
   Get the client id/secret from **Carerix → Identity Access → Clients**.

2. **Deploy to Vercel** (Git import, or `vercel --prod`). Local dev: `vercel dev`.

3. Open `/api/duplicates?debug=schema` once and confirm the candidate field
   names, then adjust the `CONFIG` block at the top of `api/duplicates.js` if
   needed (query name, selected fields, and the value extractors).

## Configuration (top of `api/duplicates.js`)

All field-name choices live in one `CONFIG` object:

```js
const CONFIG = {
  queryName: 'crEmployeePage',
  itemSelection: `... GraphQL fields ...`,
  getEmails: (c) => [c.emailAddress, c.businessEmailAddress],
  getPhones: (c) => [c.toUser?.mobileNumber, ...],
  // ...
};
```

## Using it inside Carerix

The dashboard is a normal URL. Link it from a Carerix menu item, or embed it in
an iframe, so it lives inside the Carerix environment without any CX Script.

## Notes

- Grouping is on **normalized** values: e-mail lower-cased; phone reduced to
  digits with Dutch `06…`/`+31…`/`0031…` treated as equal.
- Matching is by e-mail **or** phone — candidates linked by either share a group.
- Duplicates are *possible* matches; always verify before merging.
