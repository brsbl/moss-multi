// ported-from: packages/shared/src/components/ui/keyboard-shortcut.tsx @ 762abb777
import { ArrowUp, ChevronLeft, ChevronRight, Command, CornerDownLeft, Option } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface KeyboardShortcutProps {
  keys: string[];
  variant?: 'on-dark' | 'on-light' | 'placeholder';
  className?: string;
  size?: 'default' | 'compact';
}

const variantClasses: Record<Required<KeyboardShortcutProps>['variant'], string> = {
  'on-dark': 'bg-ink-default/20 text-ink-inverse shadow-sm',
  'on-light': 'bg-border-subtle/50 text-ink-default shadow-sm',
  placeholder: 'bg-ink-default/5 text-ink-faint shadow-none'
};

const sizeWrapperClasses: Record<NonNullable<KeyboardShortcutProps['size']>, string> = {
  default: 'gap-1.5',
  compact: 'gap-1'
};

const sizeKeyClasses: Record<NonNullable<KeyboardShortcutProps['size']>, string> = {
  default: 'h-7 min-w-7 w-auto px-1.5 text-sm',
  compact: 'h-5 min-w-5 w-auto px-1 text-xs'
};

const sizeIconClasses: Record<NonNullable<KeyboardShortcutProps['size']>, string> = {
  default: 'h-4 w-4',
  compact: 'h-3 w-3'
};

/** Render icon or text for a keyboard key */
function KeyContent({ keyChar, iconClass }: { keyChar: string; iconClass: string }) {
  switch (keyChar) {
    case '⌘':
      return <Command className={iconClass} />;
    case '⌥':
      return <Option className={iconClass} />;
    case '⇧':
      return <ArrowUp className={iconClass} />;
    case '←':
      return <ChevronLeft className={iconClass} />;
    case '→':
      return <ChevronRight className={iconClass} />;
    case '⏎':
      return <CornerDownLeft className={iconClass} />;
    default:
      return <span className="flex items-center justify-center uppercase leading-none">{keyChar}</span>;
  }
}

export function KeyboardShortcut({
  keys,
  variant = 'on-light',
  className,
  size = 'default'
}: KeyboardShortcutProps) {
  return (
    <span className={cn('flex items-center', sizeWrapperClasses[size], className)}>
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className={cn(
            'flex items-center justify-center rounded leading-none tracking-wide',
            variantClasses[variant],
            sizeKeyClasses[size]
          )}
        >
          <KeyContent keyChar={key} iconClass={sizeIconClasses[size]} />
        </kbd>
      ))}
    </span>
  );
}

export default KeyboardShortcut;
