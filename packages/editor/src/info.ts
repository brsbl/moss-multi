// The frame entry's identity (contract.ts MossEditorInfo), equal to editor.json's fields and to the host module's.
import type { MossEditorApiVersion, MossEditorInfo } from './contract';
import { MOSS_EDITOR_INFO as HOST_INFO } from './host/moss-editor-host.js';

export const MOSS_EDITOR_API: MossEditorApiVersion = 2;

export const MOSS_EDITOR_INFO: MossEditorInfo = Object.freeze({
  api: MOSS_EDITOR_API,
  version: HOST_INFO.version,
  features: Object.freeze([...HOST_INFO.features]),
});
