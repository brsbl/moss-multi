// ported-from: packages/desktop/src/renderer/editor/utils/nested-editable-block.ts @ 762abb777
import {
  $convertToMarkdownString,
  type Transformer
} from '@lexical/markdown';
// moss-multi seam: linear-import (A§12; SP2)
import { $convertFromMarkdownString } from '../markdown/linear-import';
import { $createParagraphNode, type ElementNode, type LexicalNode } from 'lexical';

export type NestedContentOptions = {
  excludedDependencies?: readonly unknown[];
  preserveNewLines?: boolean;
};

export type NestedContentDependencyItem = {
  dependencies?: readonly unknown[];
};

export type NestedContentContext = {
  matches: (node: LexicalNode) => boolean;
  excludedDependencies: readonly unknown[];
};

const nestedContentOptionsStack: NestedContentOptions[] = [];

function getActiveNestedContentOptions(): NestedContentOptions {
  return nestedContentOptionsStack[nestedContentOptionsStack.length - 1] ?? {};
}

function composeNestedContentOptions(
  activeOptions: NestedContentOptions,
  options: NestedContentOptions
): NestedContentOptions {
  const excludedDependencies = [
    ...(activeOptions.excludedDependencies ?? []),
    ...(options.excludedDependencies ?? [])
  ].filter((dependency, index, dependencies) => dependencies.indexOf(dependency) === index);

  return {
    ...options,
    excludedDependencies
  };
}

function withNestedContentOptions<T>(
  options: NestedContentOptions,
  callback: (options: NestedContentOptions) => T
): T {
  const composedOptions = composeNestedContentOptions(
    getActiveNestedContentOptions(),
    options
  );
  nestedContentOptionsStack.push(composedOptions);
  try {
    return callback(composedOptions);
  } finally {
    nestedContentOptionsStack.pop();
  }
}

export function filterNestedContentItems<T>(
  items: readonly T[],
  options: NestedContentOptions
): T[] {
  const excludedDependencies = options.excludedDependencies ?? [];
  if (excludedDependencies.length === 0) {
    return [...items];
  }

  return items.filter((item) => {
    const deps = (item as NestedContentDependencyItem).dependencies;
    if (!deps) return true;
    return !deps.some((dependency) => excludedDependencies.includes(dependency));
  });
}

export function isNestedContentItemAllowed(
  item: NestedContentDependencyItem,
  options: NestedContentOptions
): boolean {
  return filterNestedContentItems([item], options).length === 1;
}

export function getNestedContentOptionsFromNode(
  node: LexicalNode,
  contexts: readonly NestedContentContext[]
): NestedContentOptions {
  const excludedDependencies: unknown[] = [];
  let current: LexicalNode | null = node;

  while (current) {
    for (const context of contexts) {
      if (!context.matches(current)) {
        continue;
      }
      for (const dependency of context.excludedDependencies) {
        if (!excludedDependencies.includes(dependency)) {
          excludedDependencies.push(dependency);
        }
      }
    }
    current = current.getParent();
  }

  return { excludedDependencies };
}

export function createNestedContentTransformers(
  transformers: readonly Transformer[],
  options: NestedContentOptions
): Transformer[] {
  const composedOptions = composeNestedContentOptions(
    getActiveNestedContentOptions(),
    options
  );
  return filterNestedContentItems(
    transformers,
    composedOptions
  );
}

export function exportNestedContentToMarkdown(
  transformers: readonly Transformer[],
  container: ElementNode,
  options: NestedContentOptions = {}
): string {
  return withNestedContentOptions(options, (composedOptions) =>
    $convertToMarkdownString(
      transformers as Transformer[],
      container,
      composedOptions.preserveNewLines ?? false
    )
  );
}

function ensureNestedContentHasParagraph(container: ElementNode): void {
  if (container.getChildrenSize() === 0) {
    container.append($createParagraphNode());
  }
}

export function importMarkdownIntoNestedContent(
  markdown: string,
  transformers: readonly Transformer[],
  container: ElementNode,
  normalize?: (container: ElementNode, options: NestedContentOptions) => void,
  options: NestedContentOptions = {}
): void {
  withNestedContentOptions(options, (composedOptions) => {
    if (markdown) {
      $convertFromMarkdownString(
        markdown,
        transformers as Transformer[],
        container,
        composedOptions.preserveNewLines ?? false
      );
      normalize?.(container, composedOptions);
    }

    ensureNestedContentHasParagraph(container);
  });
}
