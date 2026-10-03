// The title field's binding to Y.Text('title') (A§10.4; R2, R3): the doc's title is the only name a note has.
//
// One TitleField per pane, stable across the notes the pane shows. moss's contenteditable stays moss's: its input,
// paste, drop and emoji paths call write(), which lands a minimal diff in the doc under TITLE_LOCAL_ORIGIN only while
// the field is open and bound to the note it titles (identity, never liveness: L§4.4). A peer's change is rendered,
// not adjudicated: it merges into Y.Text at once and repaints with the caret remapped through the change's delta,
// except mid-composition, when the repaint waits for compositionend. Every change, local or a peer's, projects the
// name moss shows everywhere else (sidebar, breadcrumb, tabs) as `title.trim() || 'Untitled'`.
import { observeField, readField, remapCaret, writeField, type FieldChange } from '@moss-multi/core/doc-fields';
import { diffText } from '@moss-multi/core/text-diff';
import { Doc, applyUpdate, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import { useSyncExternalStore } from 'react';
import { OPENING_NOTE } from '../opening-guard.ts';
import { refuseInput } from '../refusal.ts';

/** Local title writes; the title's own undo manager (T1.6) tracks this origin. */
export const TITLE_LOCAL_ORIGIN = Symbol('moss-multi:title-local');

/** moss's display name for a note whose title is empty; never authored into the doc (A§5.1). */
export const UNTITLED = 'Untitled';

export const displayTitle = (text: string): string => text.trim() || UNTITLED;

/** The tab's bound titles by doc id, for metadata the bridge serves while a doc is open (A§9 overlay). */
const bound = new Map<string, TitleField>();
const fieldListeners = new Set<() => void>();
const changed = () => { for (const listener of fieldListeners) listener(); };
export function useFieldWritable(docId: string): boolean {
  return useSyncExternalStore((listener) => { fieldListeners.add(listener); return () => { fieldListeners.delete(listener); }; },
    () => bound.get(docId)?.writable ?? false, () => false);
}

/** The doc's title as its binding holds it now, or null when no pane of this tab binds it. */
export function liveTitle(docId: string): string | null {
  return bound.get(docId)?.text ?? null;
}

/** A rename through the bridge (`notes.update({title})`) lands in the bound doc; false when none is bound. */
export function writeLiveTitle(docId: string, text: string): boolean {
  const field = bound.get(docId);
  return field ? field.writeText(text) : false;
}

interface Selection {
  start: number;
  end: number;
}

function selectionIn(el: HTMLElement): Selection | null {
  const selection = el.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const offset = (node: Node, at: number) => {
    const before = el.ownerDocument.createRange();
    before.setStart(el, 0);
    before.setEnd(node, at);
    return before.toString().length;
  };
  return { start: offset(range.startContainer, range.startOffset), end: offset(range.endContainer, range.endOffset) };
}

function select(el: HTMLElement, { start, end }: Selection): void {
  const text = el.firstChild;
  const range = el.ownerDocument.createRange();
  if (text?.nodeType === Node.TEXT_NODE) {
    const length = text.textContent?.length ?? 0;
    range.setStart(text, Math.min(start, length));
    range.setEnd(text, Math.min(end, length));
  } else {
    range.selectNodeContents(el);
    range.collapse(true);
  }
  const selection = el.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

interface Binding {
  docId: string;
  doc: Doc;
  stop: () => void;
}

export class TitleField {
  #element: { current: HTMLElement | null } | null = null;
  #display: ((text: string) => void) | null = null;
  #binding: Binding | null = null;
  /** The note the pane shows now. */
  #noteId: string | null = null;
  #open = false;
  /** A focus asked for while the field was closed, for this note. */
  #pendingFocus: string | null = null;
  #composing = false;
  #composition: { doc: Doc; base: Uint8Array } | null = null;

  constructor(private readonly project: (docId: string, title: string) => void) {}

  /** CanvasAreaContent's field and display setter, handed over on every render. */
  connect(element: { current: HTMLElement | null }, display: (text: string) => void): void {
    this.#element = element;
    this.#display = display;
  }

  /** The note the pane shows: writes land only in its own doc. */
  show(noteId: string | null): void {
    this.#noteId = noteId;
  }

  get writable(): boolean { return this.#open && this.#binding?.docId === this.#noteId; }

  get text(): string | null {
    return this.#binding ? readField(this.#binding.doc, 'title') : null;
  }

  /** At first sync, before the field opens: the doc's title is rendered and every later change observed. */
  bind(docId: string, doc: Doc): void {
    if (this.#binding?.doc === doc) return;
    this.unbind();
    const stopObserving = observeField(doc, 'title', (text, change) => {
      this.project(docId, text);
      if (change.origin !== TITLE_LOCAL_ORIGIN) this.#render(text, change.delta);
    });
    const onCompositionStart = (event: Event) => {
      if (!this.#owns(event.target) || !this.#open) return;
      this.#composing = true;
      const draft = new Doc();
      applyUpdate(draft, encodeStateAsUpdate(doc));
      this.#composition = { doc: draft, base: encodeStateVector(draft) };
    };
    const onCompositionEnd = (event: Event) => {
      if (!this.#owns(event.target)) return;
      const draft = this.#composition;
      const el = this.#element?.current;
      if (draft && el && this.#open) {
        writeField(draft.doc, 'title', el.textContent ?? '', TITLE_LOCAL_ORIGIN);
        applyUpdate(doc, encodeStateAsUpdate(draft.doc, draft.base), TITLE_LOCAL_ORIGIN);
      }
      this.#composing = false;
      this.#composition = null;
      draft?.doc.destroy();
      const text = readField(doc, 'title');
      this.#render(text, diffText(el?.textContent ?? '', text));
    };
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    this.#binding = {
      docId,
      doc,
      stop: () => {
        stopObserving();
        document.removeEventListener('compositionstart', onCompositionStart, true);
        document.removeEventListener('compositionend', onCompositionEnd, true);
      },
    };
    bound.set(docId, this);
    const text = readField(doc, 'title');
    this.#render(text, null);
    this.project(docId, text);
  }

  /** The doc this pane bound is gone; only that binding's own release unbinds. */
  unbind(doc?: Doc): void {
    const binding = this.#binding;
    if (!binding || (doc && binding.doc !== doc)) return;
    binding.stop();
    if (bound.get(binding.docId) === this) bound.delete(binding.docId);
    this.#binding = null;
    this.#open = false;
    this.#composing = false;
    this.#composition?.doc.destroy();
    this.#composition = null;
    changed();
  }

  /** Open: bound, synced, editable and not terminal (A§10.4). A focus asked for while closed runs now. */
  setOpen(open: boolean): void {
    this.#open = open && this.#binding !== null && this.#binding.docId === this.#noteId;
    changed();
    if (!this.#open || this.#pendingFocus === null) return;
    const wanted = this.#pendingFocus;
    this.#pendingFocus = null;
    if (wanted !== this.#noteId) return;
    const el = this.#element?.current;
    if (!el) return;
    el.focus();
    select(el, { start: 0, end: el.textContent?.length ?? 0 });
  }

  /** moss's focusTitle, Rename and ⌘T: true when the field is closed, so the focus waits for it to open. */
  deferFocus(): boolean {
    if (this.#open) return false;
    this.#pendingFocus = this.#noteId;
    return true;
  }

  /** The field's text after a local input, paste, drop or emoji pick. A closed field's input is refused out loud. */
  write(text: string): void {
    const binding = this.#binding;
    if (!binding || !this.#open || binding.docId !== this.#noteId) {
      refuseInput(OPENING_NOTE);
      if (binding) this.#render(readField(binding.doc, 'title'), null);
      return;
    }
    writeField(this.#composition?.doc ?? binding.doc, 'title', text, TITLE_LOCAL_ORIGIN);
  }

  /** A rename from outside the field (the bridge): rendered as a peer's change would be. */
  writeText(text: string): boolean {
    const binding = this.#binding;
    if (!binding || !this.#open) return false;
    const before = readField(binding.doc, 'title');
    if (!writeField(binding.doc, 'title', text, TITLE_LOCAL_ORIGIN)) return true;
    this.#render(text, diffText(before, text));
    return true;
  }

  #owns(target: EventTarget | null): boolean {
    const el = this.#element?.current;
    return !!el && target instanceof Node && el.contains(target);
  }

  #render(text: string, delta: FieldChange['delta'] | null): void {
    const el = this.#element?.current;
    if (el && el.textContent !== text) {
      if (this.#composing) {
        return;
      }
      const focused = el.ownerDocument.activeElement === el;
      const selection = focused ? selectionIn(el) : null;
      el.textContent = text;
      if (selection) {
        const remap = (offset: number) => Math.min(delta ? remapCaret(offset, delta) : offset, text.length);
        select(el, { start: remap(selection.start), end: remap(selection.end) });
      }
    }
    this.#display?.(text);
  }
}
