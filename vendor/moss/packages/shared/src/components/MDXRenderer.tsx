// ported-from: packages/shared/src/components/MDXRenderer.tsx @ 762abb777
import { useEffect, useState } from 'react';
import * as runtime from 'react/jsx-runtime';

import { cn } from '@/lib/utils';

interface MDXRendererProps {
  content: string;
  className?: string;
}

export function MDXRenderer({ content, className }: MDXRendererProps) {
  const [MDXContent, setMDXContent] = useState<React.ComponentType | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function compileMDX() {
      try {
        const { compile, run } = await import('@mdx-js/mdx');
        const remarkGfm = (await import('remark-gfm')).default;
        const compiled = await compile(content, {
          outputFormat: 'function-body',
          development: false,
          remarkPlugins: [remarkGfm]
        });

        const baseUrl =
          typeof window !== 'undefined' && typeof window.location?.href === 'string'
            ? window.location.href
            : 'http://localhost/';
        const { default: Component } = await run(compiled, {
          ...runtime,
          baseUrl
        });

        setMDXContent(() => Component);
        setError(null);
      } catch (err) {
        console.error('MDX compilation error:', err);
        setError(err as Error);
      }
    }

    compileMDX();
  }, [content]);

  if (error) {
    return (
      <div className="rounded-lg border border-status-error-border bg-status-error-surface p-4 text-sm text-status-error-text">
        <strong>MDX Error:</strong> {error.message}
      </div>
    );
  }

  if (!MDXContent) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-ink-subtle">Loading...</div>
      </div>
    );
  }

  return (
    <article className={cn('prose prose-sm prose-moss w-full max-w-none overflow-hidden', className)}>
      <MDXContent />
    </article>
  );
}
