# Glyphdown reference shots

The glyphdown side of every triptych for a surface moss lacks (A§20). Each shot is glyphdown@faf98d0 at 1440×1000 CSS px, captured at 2× (2880×2000 PNG) on 2026-10-02. The images are attachments on the M0 pull request (#2); open them signed in to GitHub.

This covers every surface PRODUCT's intro names (login, share dialog, history panel, notifications inbox, connection banner, presence) plus the vault switcher and suggestions from BUILDPLAN T0.11. Glyphdown is the design reference only: ours is built from the moss DS, and where PRODUCT differs (email and password sign-in, moss chrome placement), PRODUCT wins.

| Surface | State | Light | Dark |
|---|---|---|---|
| Login card | Signed out at `/login`: glyphdown offers only GitHub and Google | [light](https://github.com/user-attachments/assets/c54d1fb0-59fc-4a85-b1f1-787137d0ae5e) | [dark](https://github.com/user-attachments/assets/850e53c9-7e10-457e-adb5-71bebec03cf2) |
| Share dialog | Owner opens Share on a doc with one member at "can edit" and a view link | [light](https://github.com/user-attachments/assets/1bfc8eb5-cfc3-4ae2-9710-abe70a5988c2) | [dark](https://github.com/user-attachments/assets/057d48fa-8844-4acd-8921-a3c5cbaec522) |
| Presence and cursors | A second person (Alex Chen) is in the doc with a word selected: face pile plus named cursor | [light](https://github.com/user-attachments/assets/f7b9b33d-3283-4f44-91d3-d54d1d735a51) | [dark](https://github.com/user-attachments/assets/fed6972f-2c2c-4821-8601-649fcaba6ba5) |
| Connection pill and offline banner | Socket closed for over 10 s after first sync: "Connecting…" pill plus the amber banner | [light](https://github.com/user-attachments/assets/dd0d8ac5-d49e-4230-a3e8-3b420b6de5b1) | [dark](https://github.com/user-attachments/assets/f7361262-af08-451c-9f02-54ce5f40e5f6) |
| Bell and inbox | Inbox open with 5 unread: mention, reply, suggestion, doc share, vault share | [light](https://github.com/user-attachments/assets/f66ae45d-dde5-43e6-bf0f-343e8120a6b4) | [dark](https://github.com/user-attachments/assets/ceda3a41-7cd0-4cc8-b667-54f886e38024) |
| Vault switcher | Open from the file browser crumb: owned vaults, a shared one with its role badge, New vault | [light](https://github.com/user-attachments/assets/81e0e1f5-d419-46c9-af55-b7e6668da996) | [dark](https://github.com/user-attachments/assets/98862b7f-5e62-4be4-9cbd-16f4f4c7aa9e) |
| Vault switcher | Inline "New vault" row after clicking New vault | [light](https://github.com/user-attachments/assets/a3f21adf-9c22-4534-a120-aeecb0ef0910) | [dark](https://github.com/user-attachments/assets/4c7c0973-549f-4a2c-9f40-30ee219bb021) |
| Vault switcher | Open from the editor sidebar footer, where it opens upward | [light](https://github.com/user-attachments/assets/095e92cf-4489-435a-8912-3c260b566b29) | [dark](https://github.com/user-attachments/assets/72739da5-669f-4dbc-be9b-0448e0d8af9a) |
| History page | `/d/<id>/history` with auto and named versions; the named one selected, diff vs current | [light](https://github.com/user-attachments/assets/df68abc3-b8b2-4278-a17a-e56f9d6464e1) | [dark](https://github.com/user-attachments/assets/c1496049-6963-457d-bf85-dcf0ce98ebc9) |
| History page | Restore confirmation over the same page | [light](https://github.com/user-attachments/assets/02c6a3e7-4bb9-4cea-be65-1d5549479cfc) | [dark](https://github.com/user-attachments/assets/17b91ce7-c231-49f0-8d27-03998d438c15) |
| Suggest mode and SuggestionsPanel | Suggest toggled on, inline insertion, panel on Suggestions with Accept and Reject | [light](https://github.com/user-attachments/assets/945b3a7c-7f2e-4fb8-afcc-631353a18d60) | [dark](https://github.com/user-attachments/assets/ef220e85-0c4e-4608-9bbf-b595ad3872ee) |

## How they were made

- A temp copy of `.refs/glyphdown` at faf98d0: `pnpm install --frozen-lockfile` (pnpm 10.30.1, arm64 Node 24.18.1), `vite build`, local D1 migrations, then `vite preview` on `127.0.0.1:62017` (Worker, DOs, D1 in workerd) with a fresh `BETTER_AUTH_SECRET`.
- Two per-run principals, Morgan Lee (owner, the viewer of every shot) and Alex Chen, both `@example.invalid`. Glyphdown signs in only through OAuth, so their user and session rows were inserted into local D1 and the browser carried a signed session cookie.
- Data came from glyphdown's own REST API: three docs with pushed content, a named version between two pushes, a second owned vault, Alex as editor on two docs, a view link, and Alex's activity (a vault share, a doc share, a suggest-mode push, a reply and an @mention).
- Driven through bb Browser Automation (headless Chrome for Testing 151.0.7922.71). The theme is glyphdown's "auto" mode under an emulated `prefers-color-scheme`; animations and the caret were frozen before each capture. Presence used a second browser context for Alex. The offline state wrapped `WebSocket` before load, closed the doc socket and pointed reconnects at a closed port.
