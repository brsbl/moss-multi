// ported-from: packages/desktop/src/renderer/prompt/selected-context.ts @ 762abb777
interface BuildPromptWithSelectedContextInput {
  prompt: string;
  selectedContext?: string | null;
  selectedContextSourceUrl?: string | null;
  prefix?: string;
}

export function buildPromptWithSelectedContext({
  prompt,
  selectedContext,
  selectedContextSourceUrl,
  prefix = ''
}: BuildPromptWithSelectedContextInput): string {
  if (!selectedContext) {
    return `${prefix}${prompt}`;
  }

  if (selectedContextSourceUrl) {
    if (selectedContext === selectedContextSourceUrl) {
      return `${prefix}[Browser context:\nURL: ${selectedContextSourceUrl}]\n\n${prompt}`;
    }
    return `${prefix}[Browser context:\nURL: ${selectedContextSourceUrl}\nSelected text: "${selectedContext}"]\n\n${prompt}`;
  }

  return `${prefix}[Selected text: "${selectedContext}"]\n\n${prompt}`;
}
