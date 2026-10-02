// ported-from: packages/desktop/src/renderer/components/FileViewer.tsx @ 762abb777
import { useState, useEffect, useMemo } from 'react';
import { File, Image, FileCode, FileText, AlertCircle, Loader2, X } from 'lucide-react';
import { filesystemApi } from '../api/electron';
import type { DirectoryEntry, ReadFileResult } from '../../common/noteTypes';

// Prism.js is available via the existing dependency
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';

export interface FileViewerProps {
  /** File to display */
  file: DirectoryEntry;
  /** Callback to close the viewer */
  onClose: () => void;
}

/** Sanitize Prism HTML output for defense-in-depth.
 * Prism only produces <span class="token ...">text</span>.
 * Strip any other tags to prevent UI spoofing via crafted grammars. */
function sanitizePrismOutput(html: string): string {
  return html.replace(/<(?!\/?span[\s>])[^>]*>/gi, '');
}

/** Map file extensions to Prism language identifiers */
const getLanguage = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    json: 'json',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    css: 'css',
    yaml: 'yaml',
    yml: 'yaml',
    sql: 'sql',
    go: 'go',
    rs: 'rust',
    html: 'html',
    xml: 'xml'
  };
  return langMap[ext] || 'plaintext';
};

/** Format file size for display */
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * File viewer component for displaying file contents.
 * Supports syntax highlighting for code, inline preview for images,
 * and info display for other file types.
 */
export const FileViewer = ({ file, onClose }: FileViewerProps) => {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ReadFileResult | null>(null);

  // Load file content on mount or file change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResult(null);

    filesystemApi.readFile.invoke(file.path)
      .then((res) => {
        if (!cancelled) {
          setResult(res);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({
            content: '',
            size: 0,
            truncated: false,
            mimeType: 'application/octet-stream',
            isText: false,
            error: err.message || 'Failed to read file'
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [file.path]);

  // Syntax highlighted content (memoized)
  const highlightedContent = useMemo(() => {
    if (!result || !result.isText || !result.content) return null;

    const language = getLanguage(file.name);
    try {
      // Check if grammar exists for this language
      const grammar = Prism.languages[language];
      if (grammar) {
        return Prism.highlight(result.content, grammar, language);
      }
      // Fallback to plain text
      return result.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    } catch {
      // Escape HTML for display
      return result.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  }, [result, file.name]);

  // Determine icon based on file type
  const FileIcon = useMemo(() => {
    if (!result) return File;
    if (result.mimeType.startsWith('image/')) return Image;
    if (result.isText) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h'].includes(ext || '')) {
        return FileCode;
      }
      return FileText;
    }
    return File;
  }, [result, file.name]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-subtle bg-surface-linen px-2 py-1.5 rounded-t-lg">
        <div className="flex items-center gap-1.5 min-w-0">
          <FileIcon className="w-3.5 h-3.5 shrink-0 text-ink-muted" />
          <span className="text-xs font-medium text-ink-default truncate">{file.name}</span>
          {result && !result.error && (
            <span className="text-nano text-ink-muted/70 shrink-0">
              ({formatSize(result.size)}{result.truncated ? ', truncated' : ''})
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="shrink-0 p-0.5 rounded hover:bg-border-subtle transition-colors"
          aria-label="Close file viewer"
        >
          <X className="w-3.5 h-3.5 text-ink-muted" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-xs text-ink-muted">
            <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
            Loading...
          </div>
        ) : result?.error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
            <AlertCircle className="w-8 h-8 text-ink-muted/50" />
            <p className="text-xs text-ink-muted">{result.error}</p>
            <p className="text-nano text-ink-muted/70">{file.path}</p>
          </div>
        ) : result?.mimeType.startsWith('image/') && result.content ? (
          // Image preview
          <div className="flex items-center justify-center h-full p-2 bg-surface-canvas/50">
            <img
              src={result.content}
              alt={file.name}
              className="max-w-full max-h-full object-contain rounded"
            />
          </div>
        ) : result?.isText && highlightedContent ? (
          // Code/text preview with syntax highlighting
          <div className="p-2">
            <pre className="text-nano leading-relaxed font-mono whitespace-pre-wrap break-words">
              <code
                dangerouslySetInnerHTML={{ __html: sanitizePrismOutput(highlightedContent) }}
                className={`language-${getLanguage(file.name)}`}
              />
            </pre>
            {result.truncated && (
              <div className="mt-2 pt-2 border-t border-border-subtle text-nano text-ink-muted/70 text-center">
                Content truncated at 100KB. Full file is {formatSize(result.size)}.
              </div>
            )}
          </div>
        ) : (
          // Fallback for binary files
          <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
            <File className="w-8 h-8 text-ink-muted/50" />
            <p className="text-xs text-ink-muted">Cannot preview this file type</p>
            <p className="text-nano text-ink-muted/70">
              {result?.mimeType || 'Unknown type'} - {formatSize(result?.size || 0)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileViewer;
