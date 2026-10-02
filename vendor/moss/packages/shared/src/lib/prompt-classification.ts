// ported-from: packages/shared/src/lib/prompt-classification.ts @ 762abb777
/**
 * Shared intent-classification regexes used by both execution-profile routing
 * (main process) and synthetic-ack generation (renderer).
 *
 * Keep these in sync — they are the single source of truth for prompt intent.
 */

export const MICRO_EDIT_RE =
  /\b(typos?|grammar|spelling|punctuation|capitali[sz]e|reword|rephrase|polish|trim|proofread|copy edit|quick fix|light edit|fix grammar|fix spelling|fix typo|fix wording)\b/i;

export const SHORT_DIRECTIVE_EDIT_RE =
  /^(?:please\s+)?(?:add|remove|delete|rename|move|reorder|sort|highlight|unhighlight|fix|update|insert|replace|format|bold|italicize|underline|strikethrough|indent|unindent|number|bullet|wrap|unwrap|collapse|flatten|clean|swap|convert|combine|separate|change|make)\b/i;

/** Maximum prompt length for short directive classification. */
export const SHORT_DIRECTIVE_MAX_LEN = 180;

export const HEAVY_WORK_RE =
  /\b(analy[sz]e|compare|synthesi[sz]e|evaluate|research|fact-?check|trade[- ]?offs?|root cause|spec|architecture|api|technical|implementation|debug|migration)\b/i;

/** Prompts that require creative judgment or generation — not suitable for fast path. */
export const GENERATIVE_WORK_RE =
  /\b(rewrite|write|create|generate|brainstorm|compose|draft|expand|summarize|shorten|condense|improve|enhance|rework|restructure|transform|elaborate|develop|produce|devise|formulate|better|rethink)\b/i;
