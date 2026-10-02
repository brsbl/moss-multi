// ported-from: packages/desktop/src/renderer/editor/components/InlinePill.tsx @ 762abb777
/**
 * Shared inline pill component for DecoratorNodes
 *
 * Used by FormulaNode, FileLinkNode, and MentionNode to render
 * consistent pill-style inline elements.
 */
import type { CSSProperties, JSX, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type PillVariant = 'formula' | 'file-link' | 'file-link-broken' | 'mention' | 'color' | 'embed-pill';

const variantStyles: Record<PillVariant, { base: string; icon?: string }> = {
  formula: {
    base: 'bg-accent-brand/15 text-accent-brand cursor-pointer'
  },
  'embed-pill': {
    base: 'bg-ink-default/5 text-ink-default hover:bg-ink-default/10 cursor-pointer',
    icon: 'text-ink-muted'
  },
  'file-link': {
    base: 'bg-file-link-primary/10 text-ink-default hover:bg-file-link-primary/15 cursor-pointer',
    icon: 'text-file-link-primary'
  },
  'file-link-broken': {
    base: 'bg-status-error-surface text-status-error-text-submitted cursor-not-allowed'
  },
  mention: {
    base: 'bg-ink-default/5 text-ink-default',
    icon: 'text-file-link-primary'
  },
  color: {
    // Color pill uses the ink-default tinted background so it reads as a
    // chip-styled color literal regardless of theme; the swatch itself
    // carries the actual color.
    base: 'bg-ink-default/5 text-ink-default font-mono font-medium hover:bg-ink-default/10 cursor-pointer'
  }
};

export interface InlinePillProps {
  /** Visual variant determining colors */
  variant: PillVariant;
  /** Text content to display */
  children: ReactNode;
  /** Optional size for padding adjustments */
  size?: 'default' | 'compact' | 'mini';
  /** Optional icon to show before content */
  icon?: LucideIcon;
  /** Optional custom icon element to show before content */
  iconElement?: ReactNode;
  /** Tooltip text */
  title?: string;
  /** Optional max length for text truncation */
  maxLength?: number;
  /** Data attribute for node key (for click/hover handling) */
  nodeKey?: string;
  /** Data attribute name for the node key */
  nodeKeyAttribute?: string;
  /** Additional data attributes for the root pill (whole-pill click/menu target) */
  dataAttributes?: Record<string, string>;
  /**
   * Additional data attributes scoped to the icon wrapper. The icon never
   * receives the content/hover target attributes, so it can stay a click/open
   * affordance without triggering text-only hover behaviors.
   */
  iconAttributes?: Record<string, string>;
  /**
   * Additional data attributes scoped to the text/content span — e.g. a
   * text-only hover-target key consumed by `useInlinePillHoverPreview`.
   */
  contentAttributes?: Record<string, string>;
  /** Tab index for keyboard navigation */
  tabIndex?: number;
  /** ARIA role */
  role?: string;
  /** Optional class names for the icon wrapper */
  iconWrapperClassName?: string;
  /** Place the icon before or after the text content */
  iconPlacement?: 'start' | 'end';
  /** Optional class names for the inner content wrapper */
  contentClassName?: string;
  /** Optional class names for the icon */
  iconClassName?: string;
  /** Optional inline styles for the root pill */
  style?: CSSProperties;
}

export function InlinePill({
  variant,
  children,
  size = 'default',
  icon: Icon,
  iconElement,
  iconPlacement = 'start',
  title,
  maxLength,
  nodeKey,
  nodeKeyAttribute = 'data-node-key',
  dataAttributes = {},
  iconAttributes,
  contentAttributes,
  tabIndex,
  role,
  iconWrapperClassName,
  contentClassName,
  iconClassName,
  style
}: InlinePillProps): JSX.Element {
  const styles = variantStyles[variant];

  const paddingClasses = size === 'mini' ? 'px-1 py-px' : size === 'compact' ? 'px-1.5 py-0.5' : 'px-2 py-0.5';
  const textClasses = size === 'mini' ? 'text-xs' : size === 'compact' ? 'text-small' : '';
  const baseClasses = `inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded-md align-baseline ${paddingClasses} ${textClasses} transition-colors`;
  const renderedIcon =
    iconElement ??
    (Icon ? (
      <Icon
        className={[
          size === 'mini' ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5',
          'shrink-0',
          styles.icon,
          iconClassName
        ].filter(Boolean).join(' ')}
        aria-hidden
      />
    ) : null);

  // Build data attributes
  const attrs: Record<string, string> = { ...dataAttributes };
  if (nodeKey) {
    attrs[nodeKeyAttribute] = nodeKey;
  }

  const iconSlot = renderedIcon != null ? (
    <span className={iconWrapperClassName ?? 'inline-flex shrink-0 items-center'} {...iconAttributes}>
      {renderedIcon}
    </span>
  ) : null;

  const contentSlot = (
    <span
      className={contentClassName ?? 'min-w-0 overflow-hidden text-ellipsis'}
      {...contentAttributes}
    >
      {typeof children === 'string' && maxLength ? `${children.slice(0, maxLength)}${children.length > maxLength ? '…' : ''}` : children}
    </span>
  );

  return (
    <span
      className={`${baseClasses} ${styles.base}`}
      title={title}
      role={role}
      tabIndex={tabIndex}
      style={style}
      {...attrs}
    >
      {iconPlacement === 'start' ? iconSlot : null}
      {contentSlot}
      {iconPlacement === 'end' ? iconSlot : null}
    </span>
  );
}

export default InlinePill;
