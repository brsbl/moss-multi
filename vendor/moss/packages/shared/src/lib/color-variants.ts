// ported-from: packages/shared/src/lib/color-variants.ts @ 762abb777
import { cva, type VariantProps } from 'class-variance-authority';

export const tabColorVariants = cva('', {
  variants: {
    color: {
      moss: 'bg-accent-brand hover:bg-accent-brand-pressed text-ink-on-accent',
      'pending-honey': 'bg-action-tab-pending-honey group-hover:bg-action-tab-pending-honey-hover text-ink-submitted',
      'pending-cream': 'bg-action-tab-pending-cream group-hover:bg-action-tab-pending-cream-hover text-ink-submitted',
      'pending-amber': 'bg-action-tab-pending-amber group-hover:bg-action-tab-pending-amber-hover text-ink-submitted',
      'completed-slate': 'bg-action-tab-completed-slate group-hover:bg-action-tab-completed-slate-hover text-ink-inverse',
      'completed-teal': 'bg-action-tab-completed-teal group-hover:bg-action-tab-completed-teal-hover text-ink-inverse',
      'completed-periwinkle': 'bg-action-tab-completed-periwinkle group-hover:bg-action-tab-completed-periwinkle-hover text-ink-inverse',
      error: 'bg-action-tab-error hover:bg-action-tab-error-hover text-status-error-text-submitted'
    }
  },
  defaultVariants: {
    color: 'moss'
  }
});

export type TabColorVariant = VariantProps<typeof tabColorVariants>['color'];
