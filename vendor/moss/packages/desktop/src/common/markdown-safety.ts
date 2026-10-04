// ported-from: packages/desktop/src/common/markdown-safety.ts @ 762abb777
export interface MarkdownSafetyLimits {
  maxChars: number;
  maxLineLength: number;
}

export interface MarkdownSafetyAssessment {
  charCount: number;
  lineCount: number;
  maxLineLength: number;
  failureReason: 'char_count' | 'line_length' | null;
}

// Rich-text hydration can recover from large notes, but pathological line lengths
// quickly blow up markdown import and DOM work in the renderer.
export const RENDERER_MARKDOWN_SAFETY_LIMITS: MarkdownSafetyLimits = {
  maxChars: 1_000_000,
  maxLineLength: 20_000
};

// Note intelligence should be much stricter than the renderer so background
// inference never ships degenerate payloads into the Claude runtime.
export const NOTE_INTELLIGENCE_MARKDOWN_SAFETY_LIMITS: MarkdownSafetyLimits = {
  maxChars: 200_000,
  maxLineLength: 8_000
};

export const assessMarkdownSafety = (
  markdown: string,
  limits: MarkdownSafetyLimits
): MarkdownSafetyAssessment => {
  let lineCount = markdown.length === 0 ? 0 : 1;
  let currentLineLength = 0;
  let maxLineLength = 0;

  for (let i = 0; i < markdown.length; i += 1) {
    const code = markdown.charCodeAt(i);
    if (code === 13) {
      continue;
    }
    if (code === 10) {
      if (currentLineLength > maxLineLength) {
        maxLineLength = currentLineLength;
      }
      currentLineLength = 0;
      lineCount += 1;
      continue;
    }
    currentLineLength += 1;
  }

  if (currentLineLength > maxLineLength) {
    maxLineLength = currentLineLength;
  }

  let failureReason: MarkdownSafetyAssessment['failureReason'] = null;
  if (maxLineLength > limits.maxLineLength) {
    failureReason = 'line_length';
  } else if (markdown.length > limits.maxChars) {
    failureReason = 'char_count';
  }

  return {
    charCount: markdown.length,
    lineCount,
    maxLineLength,
    failureReason
  };
};
