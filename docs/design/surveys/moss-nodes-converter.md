# Survey: moss Lexical nodes and the markdown converter (pin 762abb777)

Input for the moss-multi architecture. Covers every node class and transformer moss registers, whether the exact client converter can run inside a Durable Object, how comments are stored, which node fields are per-viewer, and a tree-level round-trip test plan.

- Moss source: `.refs/moss` (snapshot of 762abb777; it has no `.git` of its own, so the pin is taken from the assignment). All moss paths below are relative to `.refs/moss/packages/desktop/src/` unless they start with `packages/`.
- Lexical facts were checked against the published `0.48.0` tarballs of `lexical`, `@lexical/{markdown,yjs,code,code-core,code-prism,react,extension,table,mark,list,rich-text,link,headless}` (moss resolves `lexical@0.48.0`, `packages/desktop/package.json`).
- Import graphs were computed with a throwaway static-analysis script over the moss sources (type-only imports ignored; implicit `react/jsx-runtime` noted separately). Nothing was built or run.

## 0. Answer first

1. **Moss registers 28 node classes** (`MARKDOWN_EDITOR_NODES`, `renderer/editor/MarkdownEditor.tsx:4161`) plus Lexical's core Root/Paragraph/Text/Tab nodes, and **45 transformer entries** (`MARKDOWN_EDITOR_TRANSFORMERS`, `MarkdownEditor.tsx:4108`): 5 multiline-element, 17 element, 8 text-format and 15 text-match. Lexical groups them by type, so order only matters within a type: multiline-element runs first on every line, then element, then text-format, then text-match. Within text-match, the earliest match wins and array order breaks ties. The import pipeline also depends on about 10 string normalizers that run before parsing and a `$postImportNormalize` pass that runs after it. Those are part of "the converter" too (§1.3).
2. **Running the exact client converter in workerd is feasible.** The transformer code, the node classes and Lexical 0.48 are DOM-free at module load and during conversion. What breaks is the module graph around them:
   - The transformers live in `MarkdownEditor.tsx`, which imports a CSS file.
   - Seven decorator files (Chart, CodeBlock, Sketch directly; Image, Video, WebEmbed, HtmlBlockquote through `components/media-primitives`) are in an import cycle: nodes → `plugins/CommentPlugin` → `utils/comment-import` → `MarkdownEditor` → nodes. If you enter the cycle at a node file instead of at `MarkdownEditor.tsx`, it crashes with a TDZ error.
   - Two files import the `@moss/shared` barrel, which pulls in Vite-only `?raw` imports.
   - A PNG import sits behind `WebEmbedNode`.
   - `@lexical/code` loads Prism components that crash under workerd unless a global `Prism` is installed first.

   **The smallest fix** is mechanical:
   - Move about 3.7k lines of transformer and normalizer code unchanged out of `MarkdownEditor.tsx` into pure modules that `MarkdownEditor.tsx` re-exports.
   - Split 8 decorator files into a pure class file and a view file: the 7 in the cycle, plus EmbedPill to drop its `api/electron` edge. Formula, ColorCode and FileLink can stay as they are, because their only view imports (`InlinePill`, lucide) are already workerd-safe. `decorate()` delegates to a view registry that only the client fills.
   - Retarget a handful of one-line imports (§2.3):
     - comment commands move to a new `commands.ts`;
     - `comment-import` imports from the new markdown module, not `MarkdownEditor`;
     - chart palettes come from `@moss/shared/lib/colors`;
     - CodeNode comes from `@lexical/code-core`, not `@lexical/code`;
     - pure helpers for color suppression and https-image detection.

   The server then imports the same `MARKDOWN_EDITOR_NODES` and `MARKDOWN_EDITOR_TRANSFORMERS` objects as the browser. The closure is about 45 moss files with externals `lexical`, `@lexical/{markdown,mark,list,rich-text,link,table,code-core,react(HR only)}`, `js-yaml`, `react` (JSX runtime and hooks) and `lucide-react` (FileLink icons). There are no twins (§2).
3. **LEARNINGS §4.3's exclusion list is partly wrong at this pin and would corrupt data if applied.**
   - FormulaNode `__name` is authored content (`name=` in `{{expr|result|id=…;name=…}}`).
   - `__result` is the authored value of every symbolic formula (`{{timeline|6 weeks}}`) and the persisted frozen value of every executable one.
   - `__format` no longer exists.
   - With `@lexical/yjs`, an excluded field takes the value from `new Klass()`, so excluding `__result` exports `{{timeline|undefined}}`.

   The verified per-viewer set is `tab-group.__activeIndex`, `tab-group.__tabWidths`, `table.__colWidths` and `file-link.__resolutionState`. `formula.__stale` and executable-formula results need a single-writer policy, not exclusion (§4).
4. **Comments today are tree content plus a sidecar.** Inline anchors are `MarkNode`s that export as `%%m:ids:start%%…%%m:ids:end%%`. Block and inline decorator anchors are a `__commentIds` array on 10 decorator classes. Threads live in `comments.json` (`id → {text, createdAt, updatedAt, source, parentId, imageUrls, resolvedAt, resolvedBy}`), and replies exist only in the sidecar.

   Moving comments into the CRDT is not just storing them elsewhere. The anchors have to leave the Lexical tree and become RelativePositions in a `comments` Y.Map, with derived paint. This is because:
   - MarkNode wraps are structural rewrites: two concurrent wraps duplicate text, and a peer typing inside the wrapped range can lose keystrokes.
   - A wrap requires tree-write permission, which a commenter does not have.
   - `__commentIds` is a last-writer-wins array.

   The converter imports markers into anchors and exports clean markdown. The moss UI code that walks MarkNodes (8 call sites, §3.1) needs an adapter (§3).
5. **Other findings that matter for the architecture:**
   - Some background tree writers fire on remote and read-only updates (§4.5).
   - Transient UI styles are written into `TextNode.__style` and would replicate (§4.4).
   - Formulas without an `id=` get a random id on every import. For symbolic formulas that random id is then written into the exported markdown. This breaks parity and merge identity (§2.2 B9).
   - Moss can silently drop a line on import. When IMAGE or TABLE's whole-line regExp matches but `replace` bails out, the line imports as an empty paragraph. Examples: remote `.mp4` media, `![a](b.png) caption (x)`, an orphan divider row. Lexical clears the line text before calling `replace`, and moss returns `undefined` instead of `false` (§1.2). This was found by static reading; L1 should confirm it.
   - The leading-H1 rule differs between moss's two import paths (§1.3).
   - Several transformers are intentionally non-identity. For example, a bare YouTube URL exports as `![YouTube video](…)`. LEARNINGS filed this as a server bug, but it is moss's own behavior (§5.4).

---

## 1. Inventory

### 1.1 Registered node classes (`MARKDOWN_EDITOR_NODES`, `MarkdownEditor.tsx:4161`, in order)

"Closure" is the number of moss source files reachable through runtime imports from that node file at the pin. A closure of 255 means the file reaches `MarkdownEditor.tsx` through the comment cycle, and with it the whole editor (React, react-dom, jotai, base-ui, lucide, prismjs, parse5, recharts via dynamic import, `MarkdownEditor.css`, the `@moss/shared` barrel with `?raw` mocks, and 6 modules that reference `window.electronAPI` lazily).

| # | Class (type) | Source | Base | Synced fields (beyond Lexical base) | Markdown form | Commentable |
|---|---|---|---|---|---|---|
| 1 | HeadingNode (`heading`) | `@lexical/rich-text` | Element | `__tag` | `#`…`######` | via MarkNode on text |
| 2 | QuoteNode (`quote`) | `@lexical/rich-text` | Element | — | `> ` | text |
| 3 | ListNode (`list`) | `@lexical/list` | Element | `__tag`, `__start`, `__listType` | `- `, `1. `, `- [ ]` | text |
| 4 | ListItemNode (`listitem`) | `@lexical/list` | Element | `__value` (derived numbering), `__checked` | — | text |
| 5 | CodeNode (`code`) | `@lexical/code` (class from `@lexical/code-core`) | Element | `__language`, `__theme`, `__isSyntaxHighlightSupported` | fence; **transient**: converted to CodeBlockNode by `$convertMossCustomCodeNodes` | — |
| 6 | CodeHighlightNode (`code-highlight`) | same | Text | `__highlightType` | — | — |
| 7 | CalloutNode (`callout`) | `renderer/editor/nodes/CalloutNode.tsx` | Element, shadow root | `__calloutType` (`warning\|info\|priority`), `__level` (`low…critical`) | ```` ```moss-callout\n<type>\n[<level>]\n<content>\n``` ```` (fence grows to fit, `buildMarkdownFence`) | text inside |
| 8 | CodeBlockNode (`code-block`) | `nodes/CodeBlockNode.tsx` | Decorator, block | `__code`, `__language` (normalized via `resolveLanguage`), `__theme`, `__commentIds` | ```` ```<lang>[--<theme>]\n<code>\n``` ```` | block |
| 9 | LinkNode (`link`) | `@lexical/link` | Element, inline | `__url`, `__target`, `__rel`, `__title` | `[text](url "title")` | text |
| 10 | AutoLinkNode (`autolink`) | `@lexical/link` | LinkNode | + `__isUnlinked` | exported as a `[text](url)` link and reimported as LinkNode | text |
| 11 | LineBreakNode (`linebreak`) | `lexical` | — | — | newline inside a block | — |
| 12 | HorizontalRuleNode (`horizontalrule`) | `@lexical/react/LexicalHorizontalRuleNode` (React subclass of the `@lexical/extension` base, same type) | Decorator | — | `---` | — |
| 13 | FormulaNode (`formula`) | `nodes/FormulaNode.tsx` | Decorator, inline | `__formula`, `__result`, `__formulaId`, `__name`, `__stale`, `__commentIds` | `{{expr\|result}}` or `{{expr\|result\|id=…;name=…;stale=1}}` | inline |
| 14 | FileLinkNode (`file-link`) | `nodes/FileLinkNode.tsx` | Decorator, inline | `__noteId`, `__noteTitle`, `__isResolved`, `__headingText`, `__resolutionState`, `__displayText`, `__commentIds` | `[[Title]]`, `[[Title#H]]`, `[[Title\|uuid]]`, `[[Title\|alias]]`, `[[#H]]` | inline |
| 15 | EmbedPillNode (`embed-pill`) | `nodes/EmbedPillNode.tsx` | Decorator, inline | `__url`, `__displayText`, `__textFormat` (own field; no collision with Lexical's `__format`), `__commentIds` | bare URL, optionally wrapped in `**`/`*`/`~~` (legacy `?[text](url)` import only) | inline |
| 16 | ColorCodeNode (`color-code`) | `nodes/ColorCodeNode.tsx` | Decorator, inline | `__value` | the literal (`#rrggbb`, `rgb[a](…)`, `hsl[a](…)`) | no |
| 17 | ChartNode (`chart`) | `nodes/ChartNode.tsx` | Decorator, block | `__config` (`{type,title,data,series,options,_parseError,_rawJson}`), `__commentIds` | ```` ```moss-chart\n<json>\n``` ```` | block |
| 18 | ImageNode (`image`) | `nodes/ImageNode.tsx` | Decorator, block | `__src`, `__altText`, `__commentIds`, `__obsidianRef` | `![alt](src)` or `![[ref]]` | block |
| 19 | SketchNode (`sketch`) | `nodes/SketchNode.tsx` | Decorator, block | `__grid` (`boolean[7200]`, 120×60), `__labels` (`TextLabel[]`), `__commentIds` | ```` ```moss-canvas\n[moss:grid:v2]…\n``` ```` (legacy `moss-sketch` imports only) | block |
| 20 | VideoNode (`video`) | `nodes/VideoNode.tsx` | Decorator, block | `__src`, `__altText`, `__commentIds` | `![alt](x.mp4\|YouTube url)` (legacy ```` ```moss-video ```` imports only) | block |
| 21 | WebEmbedNode (`web-embed`) | `nodes/WebEmbedNode.tsx` | Decorator, block | `__url`, `__altText`, `__commentIds` | `![alt](https://…)` (safe non-image URL); a bare tweet URL on its own line imports as this node | block |
| 22 | HtmlBlockquoteNode (`html-block`) | `nodes/HtmlBlockquoteNode.tsx` | Decorator, block | `__rawHtml`, `__source` (`fenced\|blockquote`), `__commentIds` | ```` ```moss-html\n<html>\n``` ```` or a verbatim `<blockquote>…</blockquote>` | block |
| 23 | TabGroupNode (`tab-group`) | `nodes/TabGroupNode.tsx` | Element, shadow root | `__activeIndex`, `__tabWidths` | `:::tabs` … `:::` | text inside |
| 24 | TabPanelNode (`tab-panel`) | `nodes/TabPanelNode.tsx` | Element, shadow root | `__label` | `=== <label>` | text inside |
| 25 | TableNode (`table`) | `@lexical/table` | Element | `__rowStriping`, `__frozenColumnCount`, `__frozenRowCount`, `__colWidths` | GFM table (widths go to `layout.json`, not markdown) | text in cells |
| 26 | TableRowNode (`tablerow`) | `@lexical/table` | Element | `__height` (unused by moss) | — | — |
| 27 | TableCellNode (`tablecell`) | `@lexical/table` | Element, shadow root | `__colSpan`, `__rowSpan`, `__headerState`, `__width`, `__backgroundColor`, `__verticalAlign` (moss uses only `__headerState`) | cell text, with `\|` and `\n` escaped | — |
| 28 | MarkNode (`mark`) | `@lexical/mark` | Element, inline | `__ids` | `%%m:ids:start%%…%%m:ids:end%%` | *is* the inline anchor |

Lexical core text fields that carry moss content: `TextNode.__format` (bold, italic, strike, code, underline, highlight bits) and `TextNode.__style`. `__style` holds authored highlight, serif and obsidian-highlight markers and also transient UI markers (§4.4). `ElementNode.__textFormat` and `__textStyle` are Lexical defaults.

**Module-load imports per moss node file** (direct runtime imports; "JSX" means the file compiles to a `react/jsx-runtime` import):

| Node file | React | CSS | DOM at load | `electronAPI` | jotai | Closure | Why it is heavy |
|---|---|---|---|---|---|---|---|
| CalloutNode.tsx | via `components/block-node-primitives` (React module; only its class-name constants are used) | no | no (`document` only in `createDOM`) | no | no | 4 | — |
| ChartNode.tsx | React, Suspense, `React.lazy(() => import('../components/ChartRenderer'))` (recharts), `@lexical/react`, lucide, base-ui dropdown and tooltip | via cycle | no | via cycle (lazy) | via cycle | 255 | `import { OPEN_BLOCK_COMMENT_COMMAND } from '../plugins/CommentPlugin'` (`:34`); `utils/chartDefaults` imports palettes from the `@moss/shared` barrel |
| CodeBlockNode.tsx | React, `@lexical/react`, lucide, keyboard-shortcut, CodeBlockToolbar | via cycle | no | via cycle | via cycle | 255 | CommentPlugin (`:22`); `utils/code-highlighting` → `plugins/code-block/prism-setup` (prismjs + 19 components) |
| ColorCodeNode.tsx | JSX (`InlinePill`) | no | no | no | no | 4 | — |
| EmbedPillNode.tsx | React hooks, lucide, `CurrentNoteIdContext` (`@lexical/react`) | no | no | `api/electron` (lazy, via `useWebEmbedPreview`) | no | 14 | — |
| FileLinkNode.tsx | JSX, lucide | no | no | no | no | 5 | — |
| FormulaNode.tsx | JSX (`InlinePill`) | no | no | no | no | 6 | — |
| HtmlBlockquoteNode.tsx | React, `@lexical/react`, lucide, preview components (react-dom portal) | via cycle | no | lazy (`useHtmlPreviewImage`) | via cycle | 255 | `components/media-primitives` → CommentPlugin; `common/moss-html-runtime` (parse5); prism |
| ImageNode.tsx | React, `@lexical/react`, `ToolbarTextInput` | via cycle | no | via cycle | via cycle | 255 | media-primitives → CommentPlugin |
| SketchNode.tsx | React, `@lexical/react`, lucide, tooltip | via cycle | no (`window` only inside functions, guarded) | via cycle | via cycle | 255 | CommentPlugin (`:22`) |
| TabGroupNode.tsx | no | no | no | no | no | 3 | — |
| TabPanelNode.tsx | no | no | no | no | no | 1 | — |
| VideoNode.tsx | React, `@lexical/react`, lucide, IframeFrame | via cycle | no | `videoThumbnailApi` from `api/electron` (lazy) | via cycle | 255 | media-primitives → CommentPlugin |
| WebEmbedNode.tsx | React, `@lexical/react`, lucide, preview components | via cycle | no | via cycle | `useSetAtom` and `openWebEmbedAtom` from `'@moss/shared'` (barrel) | 255 | barrel (`?raw` mocks); `web-embed/TweetEmbedCard` imports `x-logo-black.png` |
| **MarkdownEditor.tsx** (hosts every transformer) | React, react-dom, all `@lexical/react` plugins, base-ui, lucide | **`import './MarkdownEditor.css'` (`:324`)** | no unguarded access; module-level statements build `theme`, `AUTOLINK_MATCHERS` (`:4222`), an editor-state cache `Map` (`:4235`) and the `MARKDOWN_EDITOR_NODES` array (`:4161`, TDZ hazard, §2.2 B5) | lazy (`error-analytics`, `MathCalculationPlugin`, `CollapsibleHeadingPlugin`, `EditorInputSamplingPlugin`, `shared/src/state/atoms.ts:53`) | yes | 256 | — |

Static scan result: no module in the 255-file closure accesses `window`, `document`, `navigator` or `localStorage` at module scope unguarded. The flagged lines were all inside functions or behind `typeof window` guards. The only executed module-scope global write is `plugins/code-block/prism-setup.ts:48–53`. Lexical itself guards every DOM probe (`lexical/src/environment.ts`, `CAN_USE_DOM`).

### 1.2 Transformers (`MARKDOWN_EDITOR_TRANSFORMERS`, `MarkdownEditor.tsx:4108–4154`)

The array order, with the type each entry is grouped under. Moss-defined entries are in `MarkdownEditor.tsx` (line given). "Export-only" means the regExp is `/^$/` with a no-op replace. It matches blank lines harmlessly: Lexical breaks out of the element loop and the empty paragraph is dropped or kept exactly as without it.

| Idx | Entry | Type | Nodes | Import | Export |
|---|---|---|---|---|---|
| 1 | `OBSIDIAN_EMBED_TRANSFORMER` (`:3047`) | element | Image | `^!\[\[([^\]]+)\]\]\s*$` → ImageNode(target before `\|`), `obsidianRef` = full ref | none (IMAGE exports `![[ref]]`) |
| 2 | `HTML_BLOCKQUOTE_TRANSFORMER` (`:3070`) | element | HtmlBlockquote | one-line `<blockquote…</blockquote>` or `&lt;blockquote…`, decoded | `source=fenced` → ```` ```moss-html ```` fence; `blockquote` → raw HTML; wrapped in block comment markers |
| 3 | `IMAGE_TRANSFORMER` (`:2936`) | element | Image, Video, WebEmbed | `^!\[.*\]\(.*\)\s*$` → `classifyMarkdownImageLine` (`utils/markdown-image.ts`): video path or YouTube → Video; tweet or safe non-image https → WebEmbed; https image or local → Image; remote non-YouTube video or trailing text → `replace` bails and the line is likely lost (see the line-loss hazard below) | ImageNode → `![alt](src)` or `![[ref]]` (alt escapes `\` and `]`) |
| 4 | `RAW_WEB_EMBED_URL_TRANSFORMER` (`:2999`) | element | EmbedPill, Image, Video, WebEmbed | line starting with `https?://`: tweet → WebEmbed, YouTube → Video(`'YouTube video'`), https image → Image, embeddable → paragraph[EmbedPill], else text; with trailing text → paragraph[pill + text] | none |
| 5 | `SKETCH_TRANSFORMER` (`:2787`) | element | Sketch | export-only (import is in `$convertMossCustomCodeNodes`) | ```` ```moss-canvas ```` + `buildSketchMarkdown` |
| 6 | `CHART_TRANSFORMER` (`:2764`) | element | Chart | export-only | `exportChartToMarkdown` (raw JSON kept when the config has a `_parseError`) |
| 7 | `VIDEO_TRANSFORMER` (`:2815`) | element | Video | export-only | `![alt](src)` |
| 8 | `WEB_EMBED_TRANSFORMER` (`:2836`) | element | WebEmbed | export-only | `![alt](url)` |
| 9 | `CALLOUT_TRANSFORMER` (`:2889`) | element | Callout | export-only | `exportCalloutToMarkdown(type, nested export with preserveNewLines, level)` |
| 10 | `CODE_BLOCK_TRANSFORMER` (`:2856`) | element | CodeBlock | export-only | ```` ```lang[--theme] ````; language `''\|undefined\|null\|none` → `plaintext` |
| 11 | `GFM_TABLE_MULTILINE_TRANSFORMER` (`:2384`) | **multiline** | Table | `handleImportAfterStartMatch`: header + divider + body rows; a preceding `<!-- moss-table-column-widths: … -->` paragraph sets `colWidths` | none |
| 12 | `TABLE_TRANSFORMER` (`:2478`) | element | Table | row-at-a-time path (live typing, legacy broken rows, merges into the previous table when column counts match) | GFM with `\| --- \|` divider after header rows; alignment is not preserved |
| 13 | `HORIZONTAL_RULE_TRANSFORMER` (`:935`) | element | HR | `^-{3,}\s*$` | `---` |
| 14 | `CHECK_LIST_WITH_OPTIONAL_TRAILING_SPACE` (`:4103`) | element | List | Lexical `CHECK_LIST` with regExp `/^(\s*)(?:[-*+]\s)?\s?(\[(\s\|x)?\])(?:\s\|$)/i` | Lexical `listExport` (exports every list type) |
| 15–18 | `...ELEMENT_TRANSFORMERS` = `HEADING`, `QUOTE`, `UNORDERED_LIST`, `ORDERED_LIST` (`@lexical/markdown/MarkdownTransformers.ts:929`) | element | Heading, Quote, List | Lexical defaults | Lexical defaults |
| 19 | `TABS_MULTILINE_TRANSFORMER` (`:3134`) | **multiline** | TabGroup, TabPanel | `^:::\s*tabs\s*$` … `^:::\s*$`; tracks code fences and nested `:::\S` depth; `=== label` headers; content before the first header → refuse; panel bodies go through `importMarkdownIntoNestedContent(getTabContentTransformers())` | `:::tabs\n=== L\n<nested export>\n\n:::\n` |
| 20 | `MOSS_HTML_MULTILINE_TRANSFORMER` (`:3320`) | **multiline** | HtmlBlockquote | `` ^ {0,3}(`{3,})moss-html(\s+.*)?$ `` up to a closing fence at least as long → `source='fenced'` | — (#2 exports) |
| 21 | `HTML_BLOCKQUOTE_MULTILINE_TRANSFORMER` (`:3282`) | **multiline** | HtmlBlockquote | multi-line `<blockquote>`…`</blockquote>` | — |
| 22 | `...MULTILINE_ELEMENT_TRANSFORMERS` = `CODE` | **multiline** | CodeNode | fenced code → CodeNode (post-processed, §1.3) | CodeNode (transient) |
| 23 | `COMMENT_MARKER_TRANSFORMER` (`:2689`) | text-match | Mark | none (`(?!)`; markers are imported by `$processCommentMarkers`) | MarkNode → `%%m:<all nested ids>:start%%…:end%%` |
| 24 | `FORMULA_TRANSFORMER` (`:957`) | text-match | Formula | `\{\{([^{}\n]+)\}\}` → `parseFormulaMarkdownPayload` (skipped in code format) | `serializeFormulaMarkdownPayload` + inline comment markers |
| 25 | `IMAGE_TEXT_MATCH_TRANSFORMER` (`:2965`) | text-match | Image, Video, WebEmbed | `^!\[.*\]\(.*\)$` only when it is the whole paragraph or list-item text (images inside list items) | none |
| 26 | `FORMATTED_EMBED_PILL_TRANSFORMER` (`:1120`) | text-match | EmbedPill | `**`/`*`/`~~`/combo-wrapped bare or legacy pill → pill with `__textFormat` | none (#27 exports) |
| 27 | `EMBED_PILL_TRANSFORMER` (`:1085`) | text-match | EmbedPill | legacy `?[text](url)` (must precede LINK) | raw URL wrapped in its supported format delimiters |
| 28 | `SELF_REFERENTIAL_LINK_EMBED_PILL_TRANSFORMER` (`:1151`) | text-match | EmbedPill | `[url](url)` where text equals url → pill | none |
| 29 | `LINK_TRANSFORMER` (moss, `:1485`) | text-match | Link | balanced-paren URLs, title, formatted link text; skips `![` | `[children](url "title")` (exports children, so nested marks survive) |
| 30 | `RAW_WEB_EMBED_URL_TEXT_TRANSFORMER` (`:1241`) | text-match | EmbedPill | inline bare URL, trimmed by `getEndIndex`; skipped inside code spans | none |
| 31 | `FILE_LINK_TRANSFORMER` (`:1333`) | text-match | FileLink | `\[\[…\]\]`, last-`\|` split, UUID suffix → resolved id, otherwise alias; `#` heading with `\#` escape | `[[Title[#H]\|alias]]`, else `[[Title[#H]\|uuid]]` if resolved, else `[[Title[#H]]]` |
| 32 | `COLOR_TRANSFORMER` (`:1005`) | text-match | ColorCode | `#[0-9a-f]{6}\b\|rgba?(…)\|hsla?(…)` (`utils/color-codes.ts:58–67`), suppressed in code, unclosed delimiters and formula-edit text | the literal |
| 33 | `OBSIDIAN_HIGHLIGHT_TRANSFORMER` (`:898`) | text-match | Text | `==text==` → style `background-color: var(--color-highlight-yellow); --obsidian-highlight: true` | `==text==` |
| 34–41 | `...FILTERED_TEXT_FORMAT_TRANSFORMERS` (`:2672`) = `BOLD_ITALIC_STAR`, `BOLD_ITALIC_UNDERSCORE`, `BOLD_STAR`, `BOLD_UNDERSCORE`, `ITALIC_STAR`, `ITALIC_UNDERSCORE`, `STRIKETHROUGH`, `INLINE_CODE` (Lexical `HIGHLIGHT ==` removed; code moved last) | text-format | Text | Lexical | Lexical (single-format exporters, code sorted last) |
| 42 | `...TEXT_MATCH_TRANSFORMERS` = Lexical `LINK` | text-match | Link | Lexical default (rarely wins; moss LINK precedes it) | shadowed by #29 |
| 43 | `HIGHLIGHT_TRANSFORMER` (`:825`) | text-match | Text | `<mark data-color="green\|yellow\|orange\|blue\|red\|purple"[ style=serif]>t</mark>` → `background-color: var(--color-highlight-<c>)` | known highlight variable, or the highlight format bit → `<mark data-color="…">` |
| 44 | `UNDERLINE_TRANSFORMER` (`:793`) | text-match | Text | `<u[ style=serif]>t</u>` | underline format → `<u>` |
| 45 | `FONT_FAMILY_TRANSFORMER` (`:862`) | text-match | Text | `<span style="font-family: …serif…">t</span>` | serif style → `<span style="font-family: serif">` |

Ordering rules that tests must pin:
- Import tries the 5 multiline-element transformers first on each line (`@lexical/markdown/MarkdownImport.ts:$importMultiline`), in the order #11, #19, #20, #21, #22. `moss-html` must precede `CODE`. Then the 17 element transformers in array order: the first match whose `replace` doesn't return `false` wins. Then text-format and text-match on the text node.
- Text-match: `findOutermostTextMatchTransformer` keeps the earliest start. A later transformer replaces the current match only if it starts strictly earlier and wraps it or lies entirely before it. Equal starts go to the earlier array entry. That is why #27 precedes #29, which precedes #31, and #26 precedes #27.
- Export tries multiline-element exporters before element exporters (`MarkdownExport.ts:createMarkdownExport`), so TABS (#19) and CODE (#22) export before #1–#18.
- A non-matching line directly after a paragraph, quote or list is appended to it with a soft LineBreak (`$importBlocks`, non-preserve mode). Nested callout content uses `preserveNewLines: true`, so it does not merge.
- **Line-loss hazard (static reading; confirm in L1).** `$importBlocks` runs `textNode.setTextContent(lineText.slice(match[0].length))` *before* calling `replace`, and stops at the first transformer whose `replace` returns anything other than `false` (`@lexical/markdown/src/MarkdownImport.ts:$importBlocks`).
  - Moss's IMAGE (#3) regExp matches the whole line. When `classifyMarkdownImageLine` rejects the line, `replace` returns `undefined`, and the line becomes an empty paragraph. Rejected lines include a remote non-YouTube video, `![a](b.png) caption (x)` (text after the image's own closing paren) and an empty src.
  - TABLE (#12) has several early `return`s after its whole-line match, for example a divider row with no table above it or a bare `|`.
  - Moss's own test only asserts the node type (`__tests__/markdown-roundtrip.test.tsx:5185`).
  - The fix is `return false` in those branches. This changes moss behavior, so it is a parity decision (§6).
- Nested sets:
  - `TABLE_TRANSFORMERS` is the full set (`:1535`, `:4157`). Cells can contain anything once `\n` is unescaped.
  - `getCalloutContentTransformers()` removes entries that depend on CalloutNode, and the nested `$convertMossCustomCodeNodes` turns an inner `moss-callout` fence into a CodeBlockNode.
  - `getTabContentTransformers()` removes entries that depend on TabGroupNode, so a nested `:::tabs` stays text.
  - The filtering is done with a module-level option stack in `utils/nested-editable-block.ts`.

### 1.3 The pipeline around the transformers (the converter is more than the array)

**Import** (`MarkdownEditor.tsx:7668` `importMarkdownValue`, `:7939` `updateContentFromMarkdown`, `:4655` paste):
1. Split layers with `common/markdown-layers.ts`: `splitFrontmatter` (`:37`, js-yaml; dates normalized), then the legacy `<!--moss:comments-->` footer strip, then the leading-H1 strip.
   - **The two moss paths disagree on the H1 rule.** Initial mount uses `/^#(?!#)\s+(.*?)(?:\s*#*)?\s*(?:\n|$)/` with no `m` flag, so it only matches at the start of the string. The in-place path and `disassembleNote` use `extractLeadingH1` (`common/markdown-utils.ts`), whose regex has the `m` flag. That one lifts the *first H1 anywhere* outside code into the title, so a note whose first line isn't its H1 is reordered on export.
2. `normalizeMarkdownForImport` (`:4067`), in order:
   - Unicode spaces → space, outside code.
   - Merge adjacent inline code spans.
   - `recoverEscapedEmphasis`.
   - `stripFormattingAroundIsolatedWikiLinks`.
   - `normalizeCommentWrappedAtxHeadings`, then `normalizeCommentWrappedImages` (`utils/comment-import.ts:113,295`).
   - `normalizeRichTextInsideHighlightsForImport`.
   - `normalizeHighlightFormattingBoundaries`.
   - `normalizeFormattingAroundEmbedPillTargets`.

   These are lossy canonicalizations by design.
3. `escapeHtmlEntities` (`:3675`): every `&…;` entity outside `moss-html` fences and escaped blockquotes becomes `\u200B&…;\u200B`, so **the canonical tree stores zero-width spaces around literal entities**. `unescapeHtmlEntities` (`:4092`) removes them on export and also moves `&#32;` spaces outside emphasis delimiters.
4. `$convertFromMarkdownString(md, MARKDOWN_EDITOR_TRANSFORMERS)`. This clears the root and runs `normalizeMarkdown` (non-preserve).
5. `$postImportNormalize(commentMetadata, root, {layoutMetadata})` (`:3508`):
   - `$convertMossCustomCodeNodes` (`:3361`): top-level CodeNodes become `moss-chart` → Chart (invalid → CodeBlock(`moss-chart`)), `moss-callout` → Callout (recursive nested import), `moss-canvas`/`moss-sketch` → Sketch (empty → CodeBlock), `moss-video` → Video (if YouTube or a local path), anything else → CodeBlock with `lang--theme` parsing.
   - `$normalizeIndentedListNesting` (`:3467`).
   - `$processCommentMarkers(metadata)` (`comment-import.ts:422`): strips markers, wraps text in MarkNodes, stamps `__commentIds` on decorators. **Markers whose id is missing from the metadata are deleted.**
   - `$applyTableLayoutMetadata` and `$applyTabGroupLayoutMetadata` (`layout.json` widths applied by table and tab-group ordinal).

**Export** (`MarkdownEditor.tsx:7739` `serializeCurrent`; `panels/CanvasAreaContent.tsx:1935–1990, 2242–2275`):
1. `unescapeHtmlEntities($convertToMarkdownString(MARKDOWN_EDITOR_TRANSFORMERS))`.
2. Defensively strip a legacy footer, then `stripTableColumnWidthComments` (`utils/markdown-export.ts:62`).
3. Collect layout with `$collectTableLayoutMetadata` and `$collectTabGroupLayoutMetadata`, which go to `layout.json`.
4. `assembleNote({frontmatter | rawFrontmatterBlock, h1Title: liveTitle.trim() || 'Untitled', body})` (`markdown-layers.ts:542`). The output is `---\n<yaml>\n---\n# Title\n\n<body>`. The raw YAML block is reused byte-for-byte when the parsed data is unchanged. Otherwise js-yaml dumps with `lineWidth:-1, noRefs, sortKeys:false, quotingType:'"'`.
5. The comments sidecar is pruned to threads reachable from surviving anchors (`pruneCommentsWithoutAnchors`, `CanvasAreaContent.tsx:1995`; `collectReachableCommentThreadIds`, `markdown-layers.ts:324`).

Also in the converter's scope: `utils/markdown-export.ts:stripMossSyntax` (the "clean portable" exporter for copy and agents). It strips markers, wiki links, formulas and moss fences. It is too lossy for `.md` export: it drops charts, canvases and the formula syntax.

---

## 2. Running the exact client converter in a Durable Object

### 2.1 What already works in workerd (verified)

- `lexical` 0.48 has no unguarded DOM access at load (`environment.ts`, `CAN_USE_DOM`). `@lexical/headless` `createHeadlessEditor` stubs `registerMutationListener`, `registerDecoratorListener`, `registerRootListener`, `getRootElement`, `getElementByKey`, `focus` and `blur` to **throw**. Update listeners still work.
- `@lexical/markdown` 0.48 depends on `@lexical/code-core`, not `@lexical/code` (npm metadata), so markdown import and export no longer pull Prism. That was not true at 0.45, where LEARNINGS §4.1 hit the Prism crash.
- Every moss transformer `replace` and `export`, every normalizer, and every helper they call is string or Lexical-tree code. The only platform APIs used are `URL`, `RegExp` lookbehind, `crypto.randomUUID` and `JSON`, all available in workerd. `createDOM`, `exportDOM`, `importDOM`, `decorate` and `updateDOM` are never called by a headless conversion.
- Every moss node constructor tolerates zero arguments, which `@lexical/yjs` needs: `initializeNodeProperties` and `createLexicalNodeFromCollabNode` call `new nodeInfo.klass()` (`@lexical/yjs/src/Utils.ts:155,467`). FormulaNode then mints a random `__formulaId`, SketchNode allocates a 7200-cell grid, and the rest leave `undefined` or defaults.
- Lexical 0.48 already ships the "split the React decorator from the node" pattern. `HorizontalRuleNode` in `@lexical/extension` is DOM-free. `@lexical/react/LexicalHorizontalRuleNode` subclasses it with the same type `horizontalrule`, adds only `decorate()`, and is import-safe in workerd (React plus hooks, no DOM at load).
- LEARNINGS §4.2's `$ensureEditorNotEmpty` patch has been upstreamed. In 0.48, `syncYjsChangesToLexical` only calls it `if (binding.root.isEmpty())` (`SyncEditorStates.ts`). Remote updates also run with `skipTransforms: true`, so node transforms (AutoArrow, FormatWhitespaceBoundary, AutoLink) do not echo remote edits. Mutation listeners still do (§4.5).

### 2.2 What breaks, and the smallest fix for each

| ID | Breaker | Evidence | Smallest fix |
|---|---|---|---|
| B1 | The transformers live in a module with a side-effect CSS import | `MarkdownEditor.tsx:324 import './MarkdownEditor.css'`. Wrangler's esbuild has no `.css` loader for the worker. Vite's worker environment may drop it, but that is undocumented behavior to depend on. | Move transformers and pipeline out of `MarkdownEditor.tsx` (§2.3). `MarkdownEditor.tsx` re-exports the same names, so every moss import site and test keeps working. |
| B2 | The `@moss/shared` barrel pulls in Vite-only `?raw` imports, mocks, test-utils, MDX, jotai atoms and every DS component | `packages/shared/src/index.ts` (33 `export *`); `shared/src/mocks/notes.ts` uses `?raw`. Reached from `utils/chartDefaults.ts:5–9` (palettes) and `nodes/WebEmbedNode.tsx:18` (`openWebEmbedAtom`) | Deep imports: `@moss/shared/lib/colors` (pure) for the palettes. `openWebEmbedAtom` moves with the WebEmbed view. |
| B3 | Asset import | `nodes/web-embed/TweetEmbedCard.tsx` imports `x-logo-black.png` | Only reachable from the WebEmbed view, so the split removes it from the server graph. |
| B4 | Prism global at load | `@lexical/code` → `@lexical/code-prism/FacadePrism.ts` does `import 'prismjs'` plus 17 components that reference a bare `Prism`. Under workerd, prism's UMD attaches to a private `{}` (finding recorded in `.refs/moss-collab/packages/core/src/prism-global-install.ts`). Moss's own `prism-setup.ts` assigns the global *after* its component imports have run. | The converter imports `CodeNode` and `CodeHighlightNode` from `@lexical/code-core` (it is the same class that `@lexical/code` re-exports). The client may keep `@lexical/code`. Keep a one-line `prism-global-install` module as the first import of any server entry that ever needs code-prism. |
| B5 | **Import cycle that fails with a TDZ error depending on entry order** | `ChartNode.tsx:34`, `CodeBlockNode.tsx:22`, `SketchNode.tsx:22` and `components/media-primitives.tsx:10` (used by Image, Video, WebEmbed, Html) import `OPEN_BLOCK_COMMENT_COMMAND` from `plugins/CommentPlugin.tsx:143`. That file imports `utils/comment-import.ts`, which imports `mapOutsideFencedCodeBlocksOnly` from `../MarkdownEditor`, and `MarkdownEditor.tsx` imports the nodes. The comment at `comment-import.ts:21–23` calls this cycle harmless, but that only holds when `MarkdownEditor.tsx` is evaluated first. Enter at `nodes/ChartNode.tsx` (as a server converter would) and `MarkdownEditor.tsx` evaluates while `ChartNode` is uninitialized. `CHART_TRANSFORMER = {dependencies: [ChartNode]}` and `MARKDOWN_EDITOR_NODES` then throw `ReferenceError: Cannot access 'ChartNode' before initialization`. If a bundler has rewritten `class` to `var`, they silently capture `undefined` instead. | Move `CREATE_COMMENT_COMMAND` and `OPEN_BLOCK_COMMENT_COMMAND` into a new `renderer/editor/commands.ts` (two `createCommand` lines). `CommentPlugin.tsx` re-exports them. Move `mapOutsideFencedCodeBlocksOnly` and the other fence walkers into the pure markdown module; `comment-import.ts` imports from there. |
| B6 | View-only dependencies in node files | React components, `@lexical/react` hooks, base-ui, lucide, recharts, parse5, `api/electron`, `CurrentNoteIdContext`, `decoratorDraftRegistry`, prism (`utils/code-highlighting.ts:1`) in the 7 cycle files plus EmbedPill | Split each decorator file into `X.ts` (class, `$createX`, `$isX`, serialization helpers) and `X.view.tsx` (components). `decorate()` returns `renderNodeView('<type>', props)` from a tiny registry that the client fills at boot. The server never calls `decorate()`. See §2.3. |
| B7 | Utility modules that couple to client modules | `utils/colorPickerTriggers.ts:$isInsideColorSuppressedRawContext` (used by COLOR, `:1005`) imports `CodeBlockNode` for an `instanceof` check (closure 255). `utils/remote-image-url.ts:1` imports `imagesApi` from `api/electron` (lazy, but it drags the Electron API module in). | Move the suppression helpers into `utils/color-codes.ts` or a new pure file, importing the CodeBlockNode *class* file (pure after the split). Split `isHttpsImageUrl` and `extractAltFromUrl` into a pure file. `remote-image-url.ts` re-exports them. |
| B8 | Headless-incompatible calls in the server binding (call time, not import) | Default `syncCursorPositionsFn` → `syncCursorPositions` → `binding.editor.getRootElement()` (`SyncCursors.ts:106`), which throws on a headless editor | The server binding passes a no-op `syncCursorPositionsFn` (5th argument of `syncYjsChangesToLexical`) and a stub provider. Never register mutation listeners server-side. |
| B9 | Nondeterministic import | The `FormulaNode` constructor calls `createFormulaId()` (`FormulaNode.tsx:44`), which mints a random UUID for every formula without `id=`. Anonymous executable formulas (`{{2+2\|4}}`) export without an id, but **symbolic** formulas always export one (`serializeFormulaMarkdownPayload`, `formula-runtime.ts:842`). So `{{timeline\|6 weeks}}` exports as `{{timeline\|6 weeks\|id=<random>}}`, and the client and the DO would write *different* ids. | Not a crash. It breaks server/client parity, structural-merge identity, history diffs and byte-exact pulls. During import, mint deterministic ids, e.g. the `createFormulaMarkdownFallbackId` that moss already uses for workspace scans (`formula-runtime.ts:extractWorkspaceFormulasFromMarkdown`). |
| B10 | Module-level mutable state in converter modules | `nested-editable-block.ts:nestedContentOptionsStack`; `CodeBlockNode.tsx:39 pendingAutoEditKeys`; `MarkdownEditor.tsx:1535 TABLE_TRANSFORMERS` | Safe: conversions are synchronous and a DO is single-threaded. The rule to state in the design is "converter calls stay synchronous". |

Nothing in the converter needs `window.electronAPI`. Every reference in the closure is inside a function (`api/electron.ts:ensureElectronAPI`, `shared/src/state/atoms.ts:53`).

### 2.3 Recommended split: one class per node type and a view registry

Goal: the browser and the DO import the *same* `MARKDOWN_EDITOR_NODES` and `MARKDOWN_EDITOR_TRANSFORMERS` objects, and moss files stay re-pinnable by copying and diffing. Each file keeps a `ported-from: <path> @ 762abb777` header.

New pure modules. These are moved code, not rewritten code: function bodies stay byte-identical.

| New file (under `renderer/editor/`) | Contents moved from | Approx. lines |
|---|---|---|
| `commands.ts` | `CREATE_COMMENT_COMMAND`, `OPEN_BLOCK_COMMENT_COMMAND` (`CommentPlugin.tsx:140–144`), `OPEN_IMAGE_ALT_TEXT_EDITOR_COMMAND` (`ImageNode.tsx:47`) | 15 |
| `markdown/text-style.ts` | highlight, serif and underline helpers plus `MARKDOWN_EDITOR_HTML_IMPORT` (`MarkdownEditor.tsx:470–790`; `HTMLElement` is used only as a type or at call time) | 320 |
| `markdown/transformers.ts` | `:793–3360` and `:4103–4190` (all transformer constants, table parsing, layout-metadata functions, `MARKDOWN_EDITOR_TRANSFORMERS`, `MARKDOWN_EDITOR_NODES`, `getCallout/TabContentTransformers`) | 2,700 |
| `markdown/normalize.ts` | `:3361–3524` (`$convertMossCustomCodeNodes`, `$normalizeIndentedListNesting`, `$postImportNormalize`) and `:3594–4101` (entity escaping, fence walkers, all import normalizers) | 680 |
| `markdown/pipeline.ts` (new, small) | `$importNoteBody(md, {comments, layout})` and `$exportNoteBody({markers})`. These name the exact sequences in §1.3 so client and DO call one function instead of re-listing steps. | 60 |
| `nodes/<X>.ts` ×8 (Chart, CodeBlock, EmbedPill, HtmlBlockquote, Image, Sketch, Video, WebEmbed). Callout, TabGroup, TabPanel, Formula, ColorCode and FileLink need no split. | class, `$create`, `$is`, and the serialization helpers that transformers import (`exportChartToMarkdown`, `buildSketchMarkdown`, `parseSketchBlock`, `unescapeEmbedPillDisplayText`, `markCodeBlockForAutoEdit`, …) | moved |
| `nodes/<X>.view.tsx` ×8 | React components, hooks, preview code | moved |
| `nodes/node-views.ts` | `registerNodeView(type, Component)` and `renderNodeView(type, props)`. Holds a `Map` and returns `null` when nothing is registered. Imports nothing heavy. | 30 |
| `nodes/register-views.ts` (client only) | imports every `*.view.tsx` and registers it. Imported once by the client editor entry. | 20 |

Retargeted imports, one line each:
- `utils/chartDefaults.ts:5` → `@moss/shared/lib/colors`.
- Transformers and the converter → `@lexical/code-core`.
- COLOR → pure suppression helper.
- IMAGE and RAW_URL → pure `remote-image-url` helpers.
- `comment-import.ts:23` → `markdown/normalize`.

HorizontalRuleNode: register `@lexical/react/LexicalHorizontalRuleNode` on both sides (import-safe in workerd), so the literal list is identical. The base class from `@lexical/extension` is an acceptable server substitute because type and JSON are identical, but using the same class keeps "one converter" literal.

Resulting server graph: about 45 moss files plus `lexical`, `@lexical/{markdown,mark,list,rich-text,link,table,code-core,extension,react(HR)}`, `react`, `lucide-react`, `js-yaml`. None of these touch the DOM at load. A closure of the pure helpers alone was computed at 26 files, all DOM-free.

Alternatives considered and rejected:
- **Bundler aliases (S0):** stub `CommentPlugin`, `media-primitives` and the barrel in the worker build. This changes the fewest moss files, but it hides the coupling in config. Vite 8 already ignores `resolveId` and aliases in some environments (LEARNINGS §4.18), and any new moss import silently re-breaks the server.
- **Lexical node replacement with a base and a React subclass per moss node (S2):** `@lexical/yjs` instantiates `new nodeInfo.klass()` from the registered class (`Utils.ts:467`) and never applies `$applyNodeReplacement`. Replacement wiring per node also invites the field drift LEARNINGS §4.16 warns about.
- **`React.lazy` views:** keeps one file per node, but every decorator suspends on first render inside Lexical's decorator Suspense boundary, which causes a flash and layout jump.
- **Server twins:** refuted by history (LEARNINGS §4.2, §4.16).

CI guards (run remotely; these are what keep the converter shared):
- **workerd import smoke:** import `markdown/pipeline` in `@cloudflare/vitest-pool-workers`, create a headless editor with `MARKDOWN_EDITOR_NODES`, and import and export one fixture per family.
- **Dependency rule** (dependency-cruiser or an ESLint `no-restricted-imports` scope): no file in the converter closure may import `*.view.tsx`, `*.css`, `@moss/shared` (barrel), `@lexical/code`, `react-dom`, `jotai` or `../api/electron`. Prove it can fail with one deliberate violation.
- **Moss-pin parity:** §5.

### 2.4 How the DO uses it (recipe, not a design)

- **Seed or import** (CLI push of a new doc, restore from markdown): `createHeadlessEditor({nodes: MARKDOWN_EDITOR_NODES})` bound to an empty Y.Doc through `createBinding(editor, stubProvider, id, doc, docMap, excludedProperties)` plus an `editor.registerUpdateListener` that calls `syncLexicalUpdateToYjs`. Then `editor.update(() => $importNoteBody(body, …), {discrete: true})`.
- **Export:** create a fresh Y.Doc and a headless editor, bind it, `observeDeep` root → `syncYjsChangesToLexical(binding, stub, events, false, () => {})`, then `Y.applyUpdate(fresh, Y.encodeStateAsUpdate(live))`, then `editor.read($exportNoteBody)`. This follows LEARNINGS §4.3 ("`observeDeep` sees only future changes").
- **Assembly:** `assembleNote({rawFrontmatterBlock: Y.Text('frontmatter'), h1Title: Y.Text('title'), body})`. For moss byte-parity, keep moss's exact layout: no blank line after `---`, and `# Title\n\n`.
- **Structural merge:** parse pushed markdown into a *scratch* headless editor with `$importNoteBody`. Do not use `$generateNodesFromMarkdownString`: moss's transformers and `$processCommentMarkers` read siblings and `$getRoot()`. Then diff the normalized JSON against the live tree. The differ must apply the same normalization: deterministic formula ids (B9) and ZWSP-wrapped entities. Otherwise every formula- or entity-bearing paragraph looks changed.
- **Cost:** the moss-collab spike measured roughly 246 KB gzipped for headless Lexical, 70–84 ms cold start, about 90 ms CPU for a 1.9 MiB import and about 80 ms for its export (LEARNINGS §4.2). The moss pure modules add an estimated tens of KB of minified code.

### 2.5 Constraint on the Worker bundle

The DO class ships in the same Worker script as TanStack Start SSR. Every statically imported module in that script is evaluated at Worker and DO startup. If the moss shell or editor is statically imported into the SSR graph, then *every* moss UI module, plus base-ui and the rest, must be import-safe in workerd. No unguarded module-scope DOM access was found in the moss closure, but that is a property no one maintains. The recommendation is that the editor and shell are loaded client-only (dynamic import behind the root route), so the Worker graph contains only the converter and the server code. The architecture should state this explicitly.

---

## 3. Comments: how moss represents them, and what changes as CRDT data

### 3.1 Moss at the pin

**Anchors in the markdown body:**

| Form | Syntax | Producer | Import |
|---|---|---|---|
| Inline text | `%%m:id[,id2]:start%%text%%m:id[,id2]:end%%`. Nested MarkNodes merge into one id list (`COMMENT_MARKER_TRANSFORMER`, `MarkdownEditor.tsx:2689`). | MarkNode (`@lexical/mark`, `__ids`) | `$processCommentMarkers` (`utils/comment-import.ts:422`): two passes over text nodes; strips markers; wraps segments in `new MarkNode(ids)` |
| Inline decorator | `%%m:ids:start%%{{…}}%%m:ids:end%%` (Formula, FileLink, EmbedPill via `wrapInlineWithCommentMarkers`, `:2751`) | `__commentIds` on the decorator | stamps `setCommentIds(activeIds)` on the next commentable decorator |
| Block decorator | marker lines around the block: `%%m:ids:start%%\n<block md>\n%%m:ids:end%%` (`wrapWithCommentMarkers`, `:2737`) for Chart, CodeBlock, HtmlBlockquote, Image, Sketch, Video, WebEmbed | `__commentIds` | an open marker on an otherwise empty line is scoped to the next decorator (`pendingDecoratorScopeIds`) |
| Legacy | `{%c:id%}text{%/c%}` (close-all) | — | read-compat; written as modern |
| Pre-normalization | `normalizeCommentWrappedAtxHeadings` (`:113`) moves markers inside `###`. `normalizeCommentWrappedImages` (`:295`) rewrites inline-wrapped images to block form, to a fixpoint, splitting surrounding prose into same-id pairs. | — | — |

The commentable decorator set is fixed in `plugins/CommentAnchorTrackerPlugin.tsx:33`: Chart, CodeBlock, EmbedPill, FileLink, Formula, HtmlBlockquote, Image, Sketch, Video, WebEmbed. The check is duck-typed (`utils/commentable-node.ts:$isCommentableDecorator`). ColorCode, Callout, TabGroup, Table and HR are not commentable themselves; text inside them is.

**Thread data (sidecar):** `comments.json`, sorted by id (`serializeCommentMetadata`, `markdown-layers.ts:275`). Location (`main/storage/note-store.ts:87, 2373–2412`):
- the note directory for internal notes;
- the sibling of `<Title>/<Title>.md` for external bundle sources;
- the Moss mirror directory for standalone external files.

The schema is `CommentMetadata` (`common/markdown-layers.ts:102`) at runtime, and `NoteComment` (`packages/shared/src/types/note-comment.ts`) adds `id` and `color`:

```text
{ [id]: { text, createdAt, updatedAt,            // unix seconds
          source?: 'user'|'agent'|'external',
          parentId?,                               // reply → root; replies have NO marker
          imageUrl?, imageUrls?: ['assets/comment-image-…png'],
          resolvedAt?, resolvedBy? } }
```

Behaviors to keep:
- **Color comes from the source:** 0 user, 3 agent, 4 external (`comment-import.ts:38–51`). `meta.json` keeps legacy `commentColors` and `nextCommentColorIndex`, which are ignored.
- **Orphan handling:** on save, threads not reachable from a surviving anchor are pruned. Replies survive through their `parentId` chain (`collectReachableCommentThreadIds`, `markdown-layers.ts:324`). The jotai atom keeps the stale entries so undo can resurrect them.
- **Import drops unknown ids:** a marker whose id is not in the metadata is stripped and its text left unmarked.
- **Concurrent sidecar edits** are three-way merged (`mergeCommentMetadata`, `markdown-layers.ts:930`): local text wins, divergent remote text is kept as a synthetic `merge-<hash>` reply, image lists are unioned, and the latest `resolvedAt` wins.
- **Creation:** `CREATE_COMMENT_COMMAND` (`plugins/CommentPlugin.tsx:221`). For text, `$wrapSelectionInMarkNode` runs as an ordinary undoable tree edit. For blocks, `setCommentIds([...ids, new])`. Ids are `crypto.randomUUID()` and timestamps are seconds. Cmd+Shift+A opens the composer.
- **Mentions in comment text:** `U+2063 @Title [U+2062 id] U+2064`, with `@folder:` for folders (`utils/comment-mentions.ts`). The id wins when present. The body has no mention node; note links in the body are `[[wiki]]` FileLinkNodes (typeahead trigger `[[`, `plugins/FileLinkTypeaheadPlugin.tsx:247`).
- **UI that locates comments through the tree:**
  - `CommentPlugin.tsx` (`forEachCommentElement`, `$getMarkNodesWithId`)
  - `CommentAnchorTrackerPlugin.tsx` (`collectLiveCommentAnchorIds`)
  - `components/CommentUIWrapper.tsx`
  - `components/CommentGutter.tsx`
  - `utils/comment-hover-state.ts`
  - `utils/comment-cleanup.ts` (unwrap on delete)
  - `TabBarPlugin.tsx` (reveals the panel containing a comment)
  - CSS `.comment-mark[data-comment-color]` (`MarkdownEditor.css:830–874`)
- **Fixture:** `packages/desktop/Moss/onboarding/01-Getting-Started-with-Moss.md` plus `01-Getting-Started-with-Moss-comments.json`. It has 16 marker pairs and 4 threads (user, agent, external, and a block comment on a chart spanning lines 484–581).

### 3.2 What changes when comments become CRDT data (PRODUCT: "threads/anchors are first-class CRDT data in the shared doc; paint is derived; export stays clean")

**Why the anchors cannot stay as MarkNodes in the synced tree:**
- A wrap deletes the text node and reinserts it inside a new MarkNode. Two concurrent wraps over overlapping text duplicate it (the refuted "WORDWORD" result, LEARNINGS §4.11).
- A peer typing inside the range while the wrap lands writes into the deleted item. That contradicts "typing after commenting never drops a keystroke".
- A commenter would need permission to write the tree structure, which the server cannot narrow to "wrap only".
- Local-only painting desyncs the binding (LEARNINGS §4.3, B24).
- `__commentIds` is a last-writer-wins array attribute, so two people commenting on one chart concurrently lose one comment.

**The model the converter has to serve** (decided elsewhere; this records the converter-facing contract):

| Moss piece | CRDT replacement | Converter impact |
|---|---|---|
| `comments.json` thread rows | `Y.Map('comments')`: `id → Y.Map {text, createdAt, updatedAt, author principalId, source, parentId, imageUrls, resolvedAt, resolvedBy, reactions}`. Timestamps stay in seconds at the moss boundary (LEARNINGS §4.8). | Import of a moss note bundle reads the sidecar or legacy footer into this map. Ids are kept. |
| MarkNode `__ids` and decorator `__commentIds` | For root comments, an anchor `{start, end}` of base64 `Y.RelativePosition`s into the `@lexical/yjs` v1 structure: the paragraph `XmlText`, where a decorator is one embed of length 1. Store glyphdown's quote, hint and status fallback beside it (`.refs/glyphdown/packages/core/src/anchor.ts`). Block comments anchor the embed `[i, i+1)`. | Never write MarkNodes or `__commentIds` into the synced tree. The fields stay on the classes (moss parity) but stay empty. The `CREATE_COMMENT_COMMAND` handler (`CommentPlugin.tsx:221`) is the one place that must instead write the map and anchor. |
| `$processCommentMarkers` on import | Import into the scratch editor with moss's function unchanged, record each MarkNode's (text key, offset) range and each decorator's ids, unwrap the MarkNodes, sync to Yjs, then mint RelativePositions through the binding. Lexical point → RelativePosition is `createRelativePosition` in `@lexical/yjs/src/SyncCursors.ts:175`, which is not exported. Either a 1-line patch to export it or an equivalent of about 40 lines over `binding.collabNodeMap` is needed. The reverse direction, `$getAnchorAndFocusForUserState`, is exported. | A new step in `$importNoteBody`. Offsets must be Yjs offsets (embed = 1), never `getTextContent()` offsets: decorator `getTextContent()` returns whole fences (`ChartNode.getTextContent` returns the whole ` ```moss-chart ` fence plus JSON). |
| `COMMENT_MARKER_TRANSFORMER` and `wrap*WithCommentMarkers` on export | Not triggered, because the tree has no MarkNodes or ids. Export is clean by construction. As a belt-and-braces check, assert zero `%%m:` and `{%c:` in output (LEARNINGS §7.3). | Keep the transformers in the list for parity. Optionally add a moss-desktop interchange export (markers plus `comments.json`) built from the map, for migration back into moss. |
| Paint (MarkNode DOM plus `.comment-mark` CSS) | Derived paint resolved from anchors on every update. Use the CSS Custom Highlight API, or an overlay with a stable per-comment element for the gutter and popover. | An adapter must answer the questions moss UI asks of the tree: "elements for comment X", "live anchor ids", "comment at this DOM point", "panel containing X". Those call sites are the 8 listed in §3.1. |
| Pruning orphans on save | Anchor `status: 'orphaned'` after RelativePosition plus quote re-anchoring fails (glyphdown thresholds 0.5, 0.8, 8 chars, 60%). Threads are never deleted by a save. | Matters for history restore and CLI push: anchors survive structural merge because untouched items keep identity. |
| `mergeCommentMetadata` | Unnecessary for live edits (Y.Map merges per key). Still needed for the folder-sync daemon importing a desktop sidecar (three-way against base). | Keep it in the pure module set (`markdown-layers.ts` is already pure). |
| Permissions | A commenter writes only `comments` (and reactions), never `root`. The server vets by the Y type touched in each transaction. | Commenting no longer mutates the Lexical tree, so the comment role gets no tree-write path. |
| Mentions and notifications | The DO parses comment text with `splitCommentMentionSegments` (pure) to fan out @mention notifications. | Reuse moss's encoding unchanged. |

---

## 4. Per-viewer state and the Yjs wire (verified against the pin)

How `@lexical/yjs` 0.48 decides what syncs (`Utils.ts:65–148, 559–620`):
- The set of synced fields is `Object.keys(new Klass())` minus the base exclusions (`__key, __parent, __prev, __next, __state, __slotHost, __slots`, element `__first, __last, __size`, root `__cachedText`, text `__text`), minus function-valued keys, minus `binding.excludedProperties.get(node.constructor)`.
- Changes are detected by `!==` on the node property, and each property is stored as one attribute: last writer wins per field, and an array or object is replaced whole.
- An excluded field is never read from Yjs, so on every remote-created node it holds the **constructor default**. In the server's export tree, that default is what gets serialized.
- Moss compiles with `useDefineForClassFields: true` (`tsconfig.base.json`) and every moss constructor assigns every field, so every declared `__field` syncs unless excluded.
- `CollaborationPlugin` 0.48 accepts `excludedProperties` (`LexicalCollaborationPlugin.tsx:47`). It is keyed by constructor, so keep the type-aware wrapper from `.refs/moss-collab/apps/web/src/moss/collab/excluded-properties.ts` but with the corrected table below.

### 4.1 Exclude from the wire (per-viewer)

| Node.field | Writers at the pin | Where moss persists it | Default on a remote node | Notes |
|---|---|---|---|---|
| `tab-group.__activeIndex` | `TabBarPlugin.tsx:542` (tab click, tag `skip-dirty`), `:564, 590, 607, 975` (add, remove, keep-only, inside content edits), `SearchPlugin.tsx:95` (reveal hit), `CommentUIWrapper.tsx:311` (reveal comment) | Nowhere (`exportJSON` only; PDF export reads the DOM) | 0 | Clamp on render if a peer deletes panels: `getActivePanel()` returns `null` when the index ≥ panel count. |
| `tab-group.__tabWidths` | `TabBarPlugin.tsx:586, 649, 964` (tag `tab-title-resize`, undoable) | `layout.json` (`$collectTabGroupLayoutMetadata`) | `[]` | Restart ruling 11: localStorage. Reuse moss's ordinal-keyed collect and apply functions (`MarkdownEditor.tsx` around `:1700–1757`) with localStorage in place of `layout.json`. Resize stops being undoable (it is no longer in the Y.UndoManager scope). Accepted. |
| `table.__colWidths` | `TableColumnResizePlugin.tsx:432` (tag `table-column-resize`); import of a legacy `<!-- moss-table-column-widths -->` comment | `layout.json` (the inline comment is stripped on save, `markdown-export.ts:62`) | `undefined` | Ruling 11. If the server importer sees the legacy comment, the widths must not be pushed into Yjs. Drop them, or seed the importing user's local layout. |
| `file-link.__resolutionState` | `FileLinkPlugin.tsx:401, 545, 548, 1182, 1191, 1406, 1691, 1694` (`unresolved`, `not_found`, `note_resolved`, `fully_resolved`, `heading_not_found`) | Nowhere (not in markdown) | `'unresolved'` (constructor default parameter) | Depends on what *this viewer* can access. Not in LEARNINGS' list. |

### 4.2 Do **not** exclude (LEARNINGS §4.3 is stale at this pin)

| Field | Why it is content at 762abb777 |
|---|---|
| `formula.__name` | Serialized as `name=` (`formula-runtime.ts:842`); set by the formula editor (`FormulaPlugin.tsx:1088–1093`). Other notes reference it (`@(name#noteId#formulaId)`). |
| `formula.__result` | For symbolic formulas (`classifyFormulaSource` → `symbolic` when the expression is a bare name and a stored display exists, `formula-runtime.ts:126`), the result *is* the authored value: `{{timeline\|6 weeks}}`, written by `FormulaPlugin.tsx:1074`. For executable formulas it is the persisted frozen fallback used when references are missing (`evaluateWorkspaceFormulas`). Excluding it makes remote and server nodes export `{{timeline\|undefined}}`. |
| `formula.__formulaId` | Identity that cross-note references resolve to. |
| `formula.__format` | Does not exist at this pin (schema dropped it, LEARNINGS §4.1 drift list). No collision remains: `EmbedPillNode` uses `__textFormat`. |

### 4.3 Derived but persisted: needs a single-writer rule, not exclusion

- **`formula.__stale` and executable `formula.__result`.** `MathCalculationPlugin.tsx:1250–1272` recomputes on every FormulaNode mutation, including remote ones; it only skips its own `formula-workspace-refresh` tag. It writes through `applyWorkspaceResultsToEditor` (`:460`). The workspace evaluation reads other notes the viewer can access (`readWorkspaceFormulasForNote`, `:214`), so two viewers can compute different `stale` values and results and fight over the field. A viewer or commenter session would also emit writes the server refuses.

  Options:
  1. Background recompute writes nothing to the Y.Doc. It renders through a per-viewer overlay (moss already has `shared/src/state/formula-registry-atoms.ts`), and the DO recomputes executable results when composing markdown (LEARNINGS C-03).
  2. Only an editor-role client with an elected "formula writer" lease writes the result.

  Option 1 is recommended. Explicit edits through the formula popover (`FormulaPlugin.tsx:1046–1115`) stay ordinary synced writes.
- **`file-link.__noteId`, `__isResolved` and `__noteTitle`.** Background resolution writes ids into the tree under `skip-dirty` (`FileLinkPlugin.tsx:391–406, 540–572, 1401–1406`), and every viewer does it on open. With collab this replicates as content edits from every viewer, and viewers get refused. Recommendation: resolve per viewer (overlay). The `[[Title|uuid]]` rewrite becomes a server-side job; the DO already maintains titles and filenames (ruling 3).
- **`listitem.__value`.** Lexical's ordinal numbering. Lexical-managed and harmless, though it adds churn.

### 4.4 Transient UI markers written into `TextNode.__style`

`__style` is one synced string, so these cannot be excluded per key. Each is set with `$patchStyleText` or `setStyle`, which also splits text nodes (a structural change). Peers would *see* them, because the CSS targets `[style*="…"]` (`MarkdownEditor.css:462, 816, 823`):

| Marker | Writer | Purpose |
|---|---|---|
| `--link-selection: true` | `MarkdownEditor.tsx:6407, 6511` (cleanup at `:6543, 6574`) | keeps the selection visible while the link popover has focus |
| `--context-selection: true` | `MarkdownEditor.tsx:7792` (`markSelectionAsContext`), cleared at `:7813` | AI-context capture (agent panel; inert per PRODUCT) |
| `--formula-draft-chip: 1` plus chip CSS, `--formula-edit-id`, `--formula-ref-note-id`, `--formula-ref-formula-id` | `MathCalculationPlugin.tsx:193–207, 317–345, 1155, 1209, 1618` (tag `formula-draft-style`) | styles a `=2+3` draft as a chip while typing; carries reference metadata until commit |

Recommendation: move the two selection markers to the CSS Custom Highlight API, and disable `--context-selection` with the inert agent panel. Formula draft chips need the same treatment: a decoration over the draft range. The reference metadata goes to a local `Map` keyed by text node, which the plugin already keeps as `referenceBindingsRef`. Authored style tokens stay: `background-color: var(--color-highlight-*)`, `font-family`/`font-size-adjust` (serif), and `--obsidian-highlight`.

### 4.5 Background tree writers that fire on remote updates or in read-only sessions

Remote updates run with `skipTransforms: true`, so node transforms are safe. Mutation and update listeners still run. These need a `COLLABORATION_TAG`/`HISTORIC_TAG` guard, or must run only for local-origin changes. Otherwise both peers apply the same structural rewrite and the CRDT merges the result into duplicates.

| Listener | File | What it writes | Registered in read-only? |
|---|---|---|---|
| `ColorCodeConversionPlugin` (TextNode mutations, initial sweep) | `plugins/ColorCodePlugin.tsx:147` | replaces `#rrggbb` text with a ColorCodeNode | **yes** (`MarkdownEditor.tsx`, unconditional `<ColorCodeConversionPlugin/>`) |
| `CodeNodeNormalizationPlugin` (CodeNode created) | `MarkdownEditor.tsx:3527` | CodeNode → CodeBlock, Chart, Callout or Sketch | no (`!readOnly`) |
| MathCalculation recompute (FormulaNode mutations) | `MathCalculationPlugin.tsx:1264` | formula fields (§4.3) | no |
| `FileLinkPlugin` resolution and title sync | `plugins/FileLinkPlugin.tsx` | §4.3 | **yes** |
| `ChecklistSortPlugin` (ListItem updated) | `ChecklistSortPlugin.tsx:38` | reorders checked items on a timer | no |
| `TabBarPlugin`, `CalloutControlsPlugin`, `EmbedPillPlugin`, `CollapsibleHeadingPlugin`, `TableColumnLayoutPlugin` | see `registerMutationListener` sites | mostly DOM and UI; audit each for `editor.update` | mixed |

This is adjacent to the converter, but the converter's post-import normalizers (`$convertMossCustomCodeNodes`, `$normalizeIndentedListNesting`) are the same code that these listeners re-run live.

### 4.6 Compound decorator fields are last-writer-wins (for the architecture)

The following are whole-value attributes:
- `code-block.__code`
- `html-block.__rawHtml`
- `chart.__config`
- `sketch.__grid` (7,200 booleans, about 7 KB per stroke write) and `__labels`
- `formula.__formula`
- `callout.__level`
- every `__commentIds`

Two people editing one code block or sketch concurrently will lose one side. LEARNINGS §4.3 proposed per-decorator Y.Map registers (for example `Y.Text` for `__code` and `__rawHtml`). If adopted, the register fields join the exclusion list and the converter reads them through the node getters, so export is unaffected.

---

## 5. Tree-level round-trip test plan

All suites run in GitHub Actions only (owner rule and restart ruling 6). String identity alone is never evidence; every assertion compares normalized Lexical JSON, and markdown bytes are checked in addition (LEARNINGS §4.16).

### 5.1 Harness layers

| Layer | Environment | What it proves |
|---|---|---|
| L1 converter unit | Vitest, Node env **without** jsdom or happy-dom (asserts `typeof document === 'undefined'`) | the converter is DOM-free; per-family import, export and fixpoint |
| L2 workerd | `@cloudflare/vitest-pool-workers`, a real DO class | identical results inside workerd; import smoke for B1–B7; Prism-free load; CPU time for a 2 MB doc |
| L3 moss-pin parity (drift alarm) | Vitest with jsdom, running *moss's original* `MarkdownEditor.tsx` pipeline vendored at 762abb777 (jest-style CSS mock as in moss's `jest.config.base.cjs`) | the split changed no behavior: same JSON and same markdown for every fixture |
| L4 Yjs replication | Node: editor A (fixture import, client binding) → Y.Doc → editor B (fresh binding, populated by `applyUpdate`) → server-style headless export | the wire carries every content field and no per-viewer field; B and the server export the same as A |
| L5 browser | Playwright journeys against the real Worker stack (CI) | a CLI-pushed doc renders the same as a UI-authored one; UI-authored → CLI pull is byte-exact against the L1 export |

### 5.2 Assertions per fixture

- **A1 import golden:** `json(import(md))` equals the checked-in golden.
- **A2 export golden:** `export(import(md))` equals the canonical markdown. Usually `md` itself; intended exceptions are listed in §5.4.
- **A3 fixpoint:** `json(import(export(import(md))))` equals `json(import(md))`, and `export` is idempotent after one pass.
- **A4 parity:** A1 and A2 results equal moss-pin results (L3).
- **A5 workerd:** A1 and A2 inside the DO equal L1.
- **A6 replication:** `json(B) == json(A)` under the §5.3 normalization, `export(B) == export(A) == serverExport`, and the excluded fields hold constructor defaults on B.
- **A7 wire scan:** decode the update or state, walk every XmlText, XmlElement and Y.Map attribute, and assert that no key in the exclusion set is present. Positive control: the same scan with exclusions disabled must find them (LEARNINGS §4.3 frame-scan method, done here at the Yjs level; the browser frame scan stays in L5).
- **A8 concurrency** (decorator families): two editors concurrently edit the same decorator field. Record last-writer-wins loss as an expected, documented outcome until §4.6 is decided. Concurrent text typing next to every inline decorator must keep both sides.
- **A9 comments** (commentable families): marker import → anchors resolve to the same text or embed in A, B and the server; export contains zero `%%m:` and `{%c:`; optional interchange export reproduces moss's marker plus sidecar bytes.

### 5.3 Normalization for JSON comparison

- Drop key-like data. Lexical JSON has no keys; compare after sorting nothing, because order is content.
- Replace anonymous formulas' `formulaId` with an ordinal (B9), or use deterministic import ids.
- Map `autolink` to `link` (AutoLinkNode exports as a link and reimports as LinkNode).
- Strip per-viewer fields (`activeIndex`, `tabWidths`, `colWidths`, `resolutionState`) and derived `listitem.value`.
- For A6 only, compare executable-formula `result` and `stale` only after a deterministic recompute, if §4.3 option 1 is adopted.
- Never normalize text content, formats, styles, ZWSP-wrapped entities or decorator payloads.

### 5.4 Family matrix (every family, with the intended non-identities to pin as expected)

| Family | Fixtures (minimum) | Intended non-identity or watch item |
|---|---|---|
| Paragraph, line break, soft-break merge | plain; blank-line separation; consecutive lines (LineBreak merge); trailing spaces; tabs (TabNode) | consecutive lines become one paragraph with LineBreaks |
| Text formats | `**b**`, `*i*`, `***bi***`, `__b__`, `_i_`, `~~s~~`, `` `c` ``, bold inline code (code is exported innermost), boundary `&#32;`, escaped-emphasis recovery `\*\*x\*\*` | `__b__` → `**b**`; recovered escapes |
| Underline, highlight, serif | `<u>`, `<mark data-color=…>` ×6 colors, `==x==`, serif `<span style>`, combinations with bold and comments | highlight boundary canonicalization (`normalizeHighlightFormattingBoundaries`) |
| HTML entities and spaces | `&#160;`, `&amp;`, `&lt;` outside and inside code and `moss-html`; NBSP and U+202F in text and in image paths | NBSP → space outside code; ZWSP stored in tree |
| Headings and title | `#`…`######`; leading H1 → title; `# T #`; no H1; H1 not on the first line (the two moss rules differ, §1.3); `# Untitled` fallback | a decision is required for the H1 rule |
| Quote and HTML blockquote | `>` multi-line; one-line and multi-line `<blockquote>`; `&lt;blockquote…` | escaped form decoded |
| Lists | bullet, ordered with start, `- [ ]`, `- [x]`, `- [ ]` without trailing space, nested mixed (checklist → indented bullets), images in list items | indentation canonicalized |
| HR | `---`, `-----` | `-----` → `---` |
| Links | `[t](u)`, title, `(…(paren)…)` URLs, formatted text, `![` exclusion, autolinked `example.com`, email | autolink → `[text](https://…)` |
| Wiki links (FileLink) | `[[T]]`, `[[T\|uuid]]`, `[[T\|alias]]`, `[[#H]]`, `[[T#H\|uuid]]`, `\#` escapes, `**[[T]]**`, inside table cells with `\|` | `**[[T]]**` → `[[T]]` |
| Embed pills | bare inline URL; `**url**`; `?[label](url)`; `[url](url)`; unsafe or loopback or `file:`; URL in inline code; several URLs in a table cell | legacy `?[…]` and `[url](url)` export as a bare URL |
| Raw URL lines | tweet, YouTube, https image, generic, generic plus trailing text | bare YouTube → `![YouTube video](url)`; bare tweet → `![](url)`; image → `![<derived alt>](url)` |
| Images | local relative path, `]` and `\` in alt, `![[ref.png\|100x200]]`, remote https, `![a](p "title")`, macOS `img (1).png`, `![a](b.png) caption (x)` | the title is dropped; the caption line is likely **lost** (§1.2 line-loss hazard), so assert the decided behavior |
| Video | `![a](clip.mp4)`, YouTube, legacy ```` ```moss-video ````, remote `https://cdn/clip.mp4` | legacy fence → image syntax; the remote video line is likely **lost** (§1.2) |
| Web embed | `![t](https://example.com)` | — |
| Code blocks | language, `lang--theme`, none, `none`/`undefined`, empty fence, a 4-backtick fence containing a 3-backtick fence, unknown `moss-foo` fence, invalid `moss-chart` | language `none` → `plaintext` |
| Callout | warning, info, priority+level, `type:`/`level:` metadata form, rich nested content (list, code, table, formula), nested callout, invalid type | nested callout → code block; metadata form → canonical |
| Chart | bar, line, stacked-bar, area; palettes; title; invalid JSON (`_rawJson` preserved) | JSON re-serialized by `serializeChartConfig` |
| Canvas | 120×60 `moss-canvas` with labels header; legacy 60×30 `moss-sketch` (upscaled); free-text ASCII art; empty fence | glyphs recomputed from neighbors (`gridToText`), so letters drawn into the grid become `#`/`-`/`\|`/`+`; legacy → `moss-canvas` |
| moss-html | fenced, fence longer than inner backticks, options after `moss-html`, entities inside | header options are not preserved (`buildMossHtmlFenceStart`) |
| Tabs | 2–3 panels, nested `:::callout`/`:::chart` lines, code fence containing `:::`, nested `:::tabs` in a panel, content before the first `===`, missing close, empty panel, panels with tables and formulas | invalid → plain text |
| Tables | header plus body, optional leading or trailing pipes, `:---:` alignment, `\|` escapes, pipes inside `{{…}}`, `[[…]]` and code spans, `\n` in cells, formatted cells and pills, AI-malformed backtick cells, broken multi-line rows, legacy width comment, adjacent tables | alignment lost; width comment removed from md (widths go to local layout) |
| Formulas | `{{2+2\|4}}`, named executable, cross-note reference, symbolic `{{timeline\|6 weeks}}`, `stale=1`, invalid payload, in inline code, in table cells | random ids for formulas without `id=` (B9); symbolic formulas gain `\|id=<random>` on first export |
| Color codes | `#ff0000`, `rgb()`, `rgba()`, `hsl()`, `hsla()`; `#fff`, `#ffffffff`, `#123` (stay text); in code; after an unclosed backtick | — |
| Comments | inline single, multi-id, nested, overlapping; across bold and highlight boundaries; wrapped ATX heading; inline-wrapped image; block markers on all 7 block decorators; inline markers on Formula, FileLink and EmbedPill; legacy `{%c:%}`; legacy footer; orphan marker without metadata; replies; resolved; the onboarding note plus sidecar | moss-multi export drops markers by design (A9) |
| Frontmatter | mapping, dates, nested lists, invalid YAML, non-mapping YAML, empty block, CRLF, a body starting with `---` HR | raw block byte-preserved when unchanged; a dump re-quotes dates |
| Composition | every inline family × each container (paragraph, heading, list item, quote, table cell, callout, tab panel); every block family × (root, callout, tab panel) | moss's `__tests__/serialization-composition-matrix.test.tsx` and `comment-node-combination-matrix.test.tsx` enumerate most of this |
| Scale | 2 MB doc (LEARNINGS limit) in L2 with CPU timing; 1,000 formulas; 50 tables | — |

### 5.5 End-to-end gates (L5)

- **G1:** a CLI push of each family fixture → open in the web editor → the DOM-normalized `[data-lexical-editor]` content and the decorator count by `data-*` attributes equal the same content authored by markdown paste in the UI. Clipboard markdown import is moss's own path (LEARNINGS §4.19). This is LEARNINGS §7.1 rule 7: "a CLI-created doc renders identically".
- **G2:** UI-authored doc → CLI pull is byte-equal to the L1 export of the same tree, with zero comment markers.
- **G3:** two principals: an editor types next to each inline decorator while the peer types elsewhere. Both texts survive and the A7 scan of the real doc-party frames shows no excluded keys.

### 5.6 Negative controls (every gate must be able to fail)

- Remove `IMAGE_TRANSFORMER` from the server set. A1 and A5 must fail on images. This is the historic `IMAGE_TRANSFORMER` regression, LEARNINGS §4.15.
- Move `EMBED_PILL_TRANSFORMER` after `LINK_TRANSFORMER`. The `?[label](url)` fixture must fail.
- Move `MOSS_HTML_MULTILINE_TRANSFORMER` after `CODE`. The `moss-html` fixture must become a code block.
- Exclude `formula.__result`. The symbolic-formula fixture must export `undefined` and fail A6.
- Disable the exclusion map. A7 must find `__activeIndex` and `__colWidths`.
- Import a node view into the converter closure. The dependency rule must fail.
- Enter the module graph at `nodes/ChartNode` on the pre-split code. The L2 import smoke must hit the TDZ error (proves B5 is real and fixed).

### 5.7 Fixture sources

- `packages/desktop/__tests__/markdown-roundtrip.test.tsx` (5,564 lines of family assertions; its import and export helpers are at `:114–330`).
- `serialization-composition-matrix.test.tsx` and `comment-node-combination-matrix.test.tsx`.
- `embed-pill-roundtrip.test.tsx`, `sketch-persistence.test.tsx`, `comment-parentid-roundtrip.test.ts`, `formula-runtime.test.ts`.
- `__tests__/fixtures/obsidian-draft-v2.md`.
- `packages/desktop/Moss/onboarding/01-Getting-Started-with-Moss.md` plus `-comments.json`, and `02-Use-Cases.md` (real demo content with every family).
- `packages/desktop/assets/skills/{notes,canvas,html,comments,formulas-variables,links,frontmatter}.md`, which document each syntax agents are told to write.

Port these as data-driven fixtures and run them through L1–L4. Keep moss's original test files runnable in L3 against the vendored pin.

---

## 6. Decisions this survey hands to the architecture

1. **Adopt the §2.3 split** (single class per type plus a view registry, pure `markdown/*` modules re-exported from `MarkdownEditor.tsx`) and the CI dependency rule. Or choose an alternative knowingly.
2. **Correct the exclusion set** (§4.1) and the formula policy: overlay recompute, with the DO composing results (§4.3, option 1 recommended).
3. **Comment anchors** as RelativePositions in `Y.Map('comments')` with derived paint, plus a MarkNode-query adapter for the 8 moss call sites (§3.2). It also needs a 1-line `@lexical/yjs` export patch, or about 40 lines of local code, for point → RelativePosition.
4. **H1 rule for import:** moss's `extractLeadingH1` (first H1 anywhere) or start-of-document only (§1.3, ruling 3).
5. **Deterministic formula ids on import** (B9).
6. **Converter bugs inherited from moss:** keep parity, or fix the data-losing ones. The line-loss hazard (§1.2) loses user text; the recommendation is to fix it (`return false`), record it as a documented deviation, and add a regression fixture.
7. **Transient `__style` markers** move to decorations (§4.4); **background writers** get remote-origin guards (§4.5).
8. **Compound decorator fields:** accept last-writer-wins, or add per-decorator registers (§4.6).
9. **Worker bundle:** editor and shell are client-only; the DO's graph contains only the converter (§2.5).
