# Shared stations pool

This Worker stores a shared YouTube station's kind (`video` or `playlist`), ID, YouTube oEmbed title, keep count, report count, and time added. It stores no accounts, sharers, listeners, keepers, IP addresses, or listening history. The connecting IP is used only as a rate-limit key and is never stored or logged by the Worker.

The API accepts and returns JSON. Only Radio Flow's main process calls it; it sends no CORS headers. Video IDs have 11 letters, digits, underscores or hyphens; playlist IDs have 10–64. POST bodies must be at most 1 KB.

| Request | Result |
| --- | --- |
| `GET /random?kind=video&ref=abcdefghijk` | A random `{ "kind", "ref", "title" }` station, weighted by `1 + keeps` and excluding the supplied station. Omit both query parameters to exclude none. `204` if none remains. |
| `POST /share` `{ "kind": "video", "ref": "abcdefghijk" }` | Checks YouTube oEmbed, inserts its title once, returns `204`; `422` if unavailable. |
| `POST /keep` `{ "kind": "video", "ref": "abcdefghijk" }` | Increments its keep count if present; returns `204`. |
| `POST /report` `{ "kind": "video", "ref": "abcdefghijk", "code": 150 }` | Accepts codes `100`, `101`, `150`. Removes a station if oEmbed no longer returns `200`, or on its fifth report; returns `204`. |

Invalid IDs and report codes return `400`, bodies over 1 KB return `413`, other routes return `404`. Reads are limited to 60 requests per 60 seconds and writes to 10 per 60 seconds per connecting IP; requests over the limit return `429`.

## Deploy

From the repository root, with access to the owner's Cloudflare account:

1. Run `pnpm --filter radio-flow-pool exec wrangler d1 create radio-flow-pool`.
2. Put the returned database ID in `pool/wrangler.jsonc` in place of `REPLACE_WITH_D1_DATABASE_ID`.
3. Run `pnpm --filter radio-flow-pool exec wrangler d1 migrations apply radio-flow-pool --remote`.
4. Run `pnpm --filter radio-flow-pool exec wrangler deploy`.
5. Replace the URL below with the deployed Worker URL for the app integration issue.

Deployed at: https://radio-flow-pool.radio-flow-pool.workers.dev
