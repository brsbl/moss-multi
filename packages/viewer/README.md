# @moss-multi/viewer

A moss note, read-only, in any page: moss's own editor at the pin in one browser bundle. It opens no socket, writes
nothing and reaches outside its bundle only through the services the host passes.

```js
import { mountMossViewer, MOSS_VIEWER_INFO } from './moss-viewer.js'; // load moss-viewer.css in the same document

const viewer = mountMossViewer(element, { markdown, layout, theme: 'light', services });
await viewer.ready;
```

The contract is `src/types.ts` (API 1). Later 1.x releases only add, and each addition is listed in
`MOSS_VIEWER_INFO.features` and viewer.json `features`:

- **`selection-1`** (1.1.0): `viewer.selection()` returns the reader's selection, or null when it is collapsed or
  outside the note body:
  - `text`: the selected plain text as rendered, never a `%%m:` comment marker;
  - `lines: {start, end}`: 1-based, inclusive lines of the note file (frontmatter and `# Title` counted), from moss's
    own export of the note, which for a file moss wrote is the file as loaded. Inside a list, table or code block they
    name the items, rows or code lines selected; elsewhere every line of each block touched;
  - `markdown`: those lines, comment markers stripped;
  - `headings`: the heading path over the selection's start, outermost first;
  - `blocks: {type, line, heading?}[]`: each top-level block touched.

  Moss markdown has no persisted block ids, so the line range plus the heading path is the stable reference.
- **`share-with-agent-1`** (1.1.0): pass `services.shareWithAgent(selection)` and moss's Share with Agent button shows
  above the note; a press calls it with `selection()` at that moment (or null). Without the service it stays hidden.

See CHANGELOG.md for each release and the host requirements (`services.htmlFrameUrl`, X post frames).
