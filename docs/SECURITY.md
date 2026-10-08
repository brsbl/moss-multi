# Security sweep

The adversarial checklist of BUILDPLAN T8.3, run first against a local production build (T8.3a) and again on staging (T8.3). Two P1 findings were fixed here: unbounded request bodies and frameable app pages. Every other check passed. The P2 findings at the end are recorded, not fixed.

## How to run it

- **Black-box sweep:** `node scripts/security/sweep.mjs --base-url <url>` signs up three `@example.invalid` principals and prints one PASS/FAIL line per check. It exits 1 on any failure.
  - CI runs it in the build job ("Security sweep") against the production-mode smoke stack, which has no test hooks.
  - A run sends about 1,000 requests. The limit checks run last because they use up the address's sign-in and sign-up windows; `--skip-limits` leaves them out.
- **Authorization matrix:** `apps/web/src/api/authz-matrix.test.ts` (unit lane) drives every `/api` route through the router for each kind of outsider. It fails when a route pattern in `api/*.ts` has no row in its table.
- **Body cap:** `apps/web/src/worker/body-cap.test.ts`. **CSP:** `apps/web/src/worker/csp.test.ts`.

## Checklist and results

Local results are from 2026-10-08, branch `t/T8.3a`, on a `stack.mjs start` stack without `--hooks`.

| Area | What is checked | How | Local |
|---|---|---|---|
| Headers | App pages carry the nonce CSP (no `unsafe-inline` scripts) and `frame-ancestors 'self'` | sweep `headers` | Pass after fix |
| Headers | `/frame/html` is `sandbox allow-scripts` only (no `allow-same-origin`) and nosniff | sweep | Pass |
| Headers | An SVG asset is served with `content-security-policy: sandbox` and nosniff | sweep | Pass |
| Headers | Unknown `/api` paths return a JSON 404, never HTML; per-caller answers are `no-store` | sweep | Pass |
| Header stripping | A stranger who sends `x-moss-principal`, `x-moss-role`, `x-moss-session` or `x-partykit-*` gets the missing-id answer on every route | sweep `existence`; matrix | Pass |
| Test hooks | Every `/__test` path, with or without a hook header, returns the unknown-route 404 | sweep (`assert-deployed.mjs` `hookProblems`) | Pass |
| Existence leaks | Every doc, trash, folder, vault and party route answers byte-identically for Ada's note, her trashed note and a missing id. This holds for strangers by cookie, bearer or agent key, a forged share token, forged trusted headers, a revoked link, a revoked key and a signed-out session. No DocDO is reached | sweep; matrix | Pass |
| Existence leaks | Search and the doc list never return another person's note | sweep | Pass |
| Origin gate | A cookie POST with no Origin, a foreign Origin, `null` or a same-site port gets 403; a cookie socket from another origin closes 4401 | sweep | Pass |
| Token threading | A viewer link reads the note, content, media and role by `?share=` or `x-moss-share`, and comments once signed in. Its socket is admitted | sweep | Pass |
| Token threading | A viewer link, signed out or in, writes nothing and sees no members, links, invites, instance or trash | sweep; matrix | Pass |
| Revocation | A revoked link answers exactly like a forged one on every read. Its open socket closes, and a new one closes 4404 | sweep | Pass |
| Agent keys | A key reads its owner's note and administers nothing (agents, links, members, trash, moves, instance) | sweep; matrix | Pass |
| Agent keys | A revoked key gets 401 everywhere. Its open socket closes, and a new one closes 4401 | sweep | Pass |
| Sign-out | The session's cookie and its bearer form both get 401. Its workspace socket closes, and a doc socket on the old cookie closes 4401 | sweep | Pass |
| SSRF | 20 targets get 422 from both `POST /api/unfurl` and `POST /api/docs/:id/assets/from-url`, and nothing is stored. The targets: http, file, loopback v4 and v6, `localhost`, metadata, RFC 1918, CGNAT, ULA, IPv4-mapped, decimal, hex, octal and short IPv4, userinfo, a non-443 port, single-label and trailing-dot hosts | sweep `ssrf` | Pass |
| Body caps | A 64 MiB declared JSON body gets 413 from its header on `/api` and `/api/auth`, signed in or not. A body just over 1 MiB gets 413. An image declared over 10 MB gets 413 | sweep `limits`; body-cap test | Pass after fix |
| Rate limits | Each limit returns 429 within its window: unfurl fetches 30/min, comment operations 60/min, REST writes 60/min, sign-in 10/min, sign-up 10/min | sweep `limits` | Pass |
| Other limits | 50 connections, 300 writes per 5 s (4420), 8 KB awareness, the 2 MB state cap, pushes 60/min, uploads 60/min, the vault media quota, invites 20/hour, suggestion and version rates, and waiting-frame bounds | unit and harness tests: `doc-do`, `principal-do`, `push.harness`, `media-admission`, `assets`, `sharing`, `auth` | Pass in CI |

## Findings

**P1, fixed in T8.3a**
- **Unbounded request bodies.** Every JSON handler and better-auth read the whole body (`request.text()`, then `JSON.parse`). `/api/unfurl` read it before resolving the caller. So one unauthenticated POST of tens of MB could exhaust a 128 MB isolate and fail the other requests it was serving.
  - Fix: `worker/route.ts` caps every `/api` and `/api/auth` body before any handler runs. A declared length over the cap gets 413 without reading. A streamed body gets 413 once it passes the cap.
  - Caps: 1 MiB for JSON; 16 MiB for `POST /api/docs` and `/push`, which carry a whole document; media uploads keep their own declared-length cap.
- **Frameable app pages.** The page CSP had no `frame-ancestors`. A same-site page (another port, a sibling subdomain) gets the Lax session cookie inside a frame, which is the attacker A§18's origin gate assumes, so it could clickjack an owner into sharing or trashing. Fix: `frame-ancestors 'self'`.

**P2, recorded for follow-up**
- App HTML and `/api` JSON responses have no `x-content-type-options: nosniff`; assets and `/frame/html` do. No user-written bytes are served under those types.
- There is no explicit `Referrer-Policy`. The browser default (`strict-origin-when-cross-origin`) already keeps `?share=` tokens out of cross-origin `Referer` headers.
- No HSTS header. Staging's `workers.dev` host is under the HSTS-preloaded `.dev` TLD; a custom domain would need one.
- `POST /api/feedback` has no rate limit, so a signed-in account can write 10,000-character rows without bound.
- An uncaught Worker exception returns Cloudflare's HTML error page on `/api`, though A§4.1 says `/api` never answers with HTML.
- The current version of an asset is `private, max-age=0, stale-while-revalidate=86400`, so a browser may show its cached copy once after the viewer's access ends.

## On staging (T8.3)

- Run `node scripts/security/sweep.mjs --base-url <staging URL>` within the run's request budget. Each run signs up three new `@example.invalid` accounts.
- Re-read on staging what a local stack cannot show:
  - The session cookie is `Secure`, `HttpOnly` and `SameSite=Lax`.
  - The auth 429s are keyed on `cf-connecting-ip`.
  - SSRF DNS answers come through DoH from Cloudflare's edge.
  - The 64 MiB declared-length probe is answered before the edge buffers a body.
- If any of these differs, it is a finding for T8.3, not a change to this checklist.
