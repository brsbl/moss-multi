// ported-from: packages/desktop/src/renderer/editor/plugins/code-block/CodeBlockToolbar.tsx @ 762abb777
/**
 * CodeBlockToolbar - Floating toolbar for code blocks
 *
 * Features:
 * - Language selector dropdown
 * - Theme selector dropdown
 * - Copy to clipboard button
 */

import type { JSX } from 'react';
import { useCallback, useRef, useState } from 'react';
import { Check, ChevronDown, Copy } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@moss/shared/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { CORE_LANGUAGES, getLanguageLabel } from './languages';
import { CODE_THEMES, getThemeLabel } from './themes';

export interface CodeBlockToolbarProps {
  language: string;
  onLanguageChange: (language: string) => void;
  theme: string;
  onThemeChange: (theme: string) => void;
  getCodeContent: () => string;
  onDropdownOpenChange?: (open: boolean) => void;
  /** moss-multi seam: read-only-decorators (T2.3): a read-only editor shows the language and theme, never changes them */
  readOnly?: boolean;
}

export function CodeBlockToolbar({
  language,
  onLanguageChange,
  theme,
  onThemeChange,
  getCodeContent,
  onDropdownOpenChange,
  readOnly = false
}: CodeBlockToolbarProps): JSX.Element {
  const [copySuccess, setCopySuccess] = useState(false);
  const openCountRef = useRef(0);

  const handleCopy = useCallback(async () => {
    try {
      const content = getCodeContent();
      await navigator.clipboard.writeText(content);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy code:', err);
    }
  }, [getCodeContent]);

  const trackDropdown = useCallback((open: boolean) => {
    openCountRef.current += open ? 1 : -1;
    onDropdownOpenChange?.(openCountRef.current > 0);
  }, [onDropdownOpenChange]);

  const currentLabel = getLanguageLabel(language);
  const currentThemeLabel = getThemeLabel(theme);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="moss-code-toolbar">
        {/* Language Selector */}
        <DropdownMenu onOpenChange={trackDropdown}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="moss-code-toolbar-btn moss-code-toolbar-language"
                  aria-label="Select language"
                  disabled={readOnly}
                >
                  <span className="truncate">{currentLabel}</span>
                  <ChevronDown size={12} aria-hidden />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Language</p></TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" sideOffset={4} updatePositionStrategy="always">
            {CORE_LANGUAGES.map((lang) => (
              <DropdownMenuItem
                key={lang.id}
                onSelect={() => { if (!readOnly) onLanguageChange(lang.id); }}
                className={language === lang.id ? 'bg-surface-panel' : ''}
              >
                <span className="flex-1">{lang.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Theme Selector */}
        <DropdownMenu onOpenChange={trackDropdown}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="moss-code-toolbar-btn moss-code-toolbar-language"
                  aria-label="Select theme"
                  disabled={readOnly}
                >
                  <span className="truncate">{currentThemeLabel}</span>
                  <ChevronDown size={12} aria-hidden />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Theme</p></TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" sideOffset={4} updatePositionStrategy="always">
            {CODE_THEMES.map((t) => (
              <DropdownMenuItem
                key={t.id}
                onSelect={() => { if (!readOnly) onThemeChange(t.id); }}
                className={theme === t.id ? 'bg-surface-panel' : ''}
              >
                <span className="flex-1">{t.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Copy Button */}
        {/* moss-multi seam: read-only-decorators (T2.3): nothing under a closed body takes focus (invariant 9); the code stays selectable */}
        {readOnly ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="moss-code-toolbar-btn"
              onClick={handleCopy}
              aria-label={copySuccess ? 'Copied!' : 'Copy code'}
            >
              {copySuccess ? (
                <Check size={14} className="text-accent-brand" aria-hidden />
              ) : (
                <Copy size={14} aria-hidden />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>{copySuccess ? 'Copied!' : 'Copy code'}</p></TooltipContent>
        </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}

export default CodeBlockToolbar;
