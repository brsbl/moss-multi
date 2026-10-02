// ported-from: packages/shared/src/components/ui/base-button.tsx @ 762abb777
import { type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { KeyboardShortcut } from './keyboard-shortcut';

export interface BaseButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  /** Visual variant */
  variant?: 'light' | 'dark' | 'terracotta' | 'ghost';
  /** Optional icon (left side, mutually exclusive with label) */
  icon?: LucideIcon;
  /** Optional label text (left side) */
  label?: string;
  /** Keyboard shortcut keys to display (omit for icon-only buttons) */
  keys?: string[];
  /** Accessible label for screen readers */
  ariaLabel: string;
}

/**
 * Base button with keyboard shortcut indicator.
 * Used for action triggers throughout the app.
 */
export function BaseButton({
  onClick,
  disabled = false,
  className,
  variant = 'light',
  icon: Icon,
  label,
  keys,
  ariaLabel
}: BaseButtonProps) {
  const variantStyles = {
    light: {
      base: 'border border-surface-glass-border bg-surface-glass shadow-sm hover:bg-surface-canvas',
      ring: 'focus-visible:ring-ink-default/20',
      text: 'text-ink-default/50'
    },
    dark: {
      base: 'border border-ink-default/5 bg-accent-brand shadow-sm hover:bg-accent-brand-pressed',
      ring: 'focus-visible:ring-ink-default/20',
      text: 'text-ink-on-accent/95'
    },
    terracotta: {
      base: 'border border-border-clear bg-accent-terracotta shadow-sm hover:bg-accent-terracotta/90',
      ring: 'focus-visible:ring-accent-terracotta',
      text: 'text-ink-on-accent'
    },
    ghost: {
      base: 'border border-border-default/30 bg-surface-panel/50 shadow-inner hover:bg-surface-panel/70',
      ring: 'focus-visible:ring-ink-default/20',
      text: 'text-ink-muted'
    }
  };

  const styles = variantStyles[variant];
  const shortcutVariant = variant === 'light' ? 'on-light' : 'on-dark';

  // Icon color to match keyboard shortcut text
  const iconStyles = {
    light: 'text-ink-default',
    dark: 'text-ink-on-accent',
    terracotta: 'text-ink-on-accent',
    ghost: 'text-ink-muted'
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-9 items-center gap-2 rounded-lg px-3 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
        label ? 'w-full' : 'w-fit',
        keys ? 'justify-between' : 'justify-start',
        styles.base,
        styles.ring,
        disabled && 'opacity-50',
        className
      )}
      aria-label={ariaLabel}
    >
      {Icon && (
        <Icon aria-hidden className={cn('h-4 w-4', iconStyles[variant])} strokeWidth={1.5} fill="none" />
      )}
      {label && (
        <span className={cn('text-xs font-medium', styles.text)}>
          {label}
        </span>
      )}
      {keys && <KeyboardShortcut keys={keys} variant={shortcutVariant} size="compact" />}
    </button>
  );
}

export default BaseButton;
