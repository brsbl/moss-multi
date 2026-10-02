// ported-from: packages/desktop/stories/DesignSystem.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';

export const meta = {
  title: 'Design System'
};

const ColorSwatch = ({ name, value, textClass = 'text-ink-default' }: { name: string; value: string; textClass?: string }) => (
  <div className="flex flex-col gap-2">
    <div className="h-16 w-32 rounded-lg border border-border-subtle shadow-sm" style={{ backgroundColor: value }} />
    <div className="flex flex-col">
      <span className={`text-small font-medium ${textClass}`}>{name}</span>
      <span className="font-mono text-micro text-ink-muted">{value}</span>
    </div>
  </div>
);

const ColorGroup = ({ title, colors }: { title: string; colors: Array<{ name: string; value: string; textClass?: string }> }) => (
  <div className="mb-8">
    <h3 className="mb-4 text-h3 text-ink-accent">{title}</h3>
    <div className="flex flex-wrap gap-6">
      {colors.map((color) => (
        <ColorSwatch key={color.name} {...color} />
      ))}
    </div>
  </div>
);

const TypographySample = ({ label, className, sample = 'The quick brown fox jumps over the lazy dog' }: { label: string; className: string; sample?: string }) => (
  <div className="mb-6 rounded-lg border border-border-subtle bg-ink-inverse p-4">
    <div className="mb-2 flex items-baseline justify-between">
      <span className="font-mono text-micro text-accent-brand">{label}</span>
      <span className="font-mono text-micro text-ink-muted">{className}</span>
    </div>
    <p className={className}>{sample}</p>
  </div>
);

export const Colors: Story = () => (
  <div className="min-h-screen bg-surface-canvas p-8">
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-8 text-h1 text-ink-accent">Color Palette</h1>

      <ColorGroup
        title="Surface Ladder"
        colors={[
          { name: 'app-background', value: 'var(--surface-canvas-bg)' },
          { name: 'canvas', value: 'var(--surface-canvas)' },
          { name: 'panel', value: 'var(--surface-panel)' },
          { name: 'chrome', value: 'var(--surface-linen)' },
          { name: 'floating-surface', value: 'var(--surface-floating)' },
          { name: 'control-surface', value: 'var(--surface-raised-control)' },
          { name: 'hover', value: 'var(--surface-note-hover)' },
          { name: 'selected', value: 'var(--surface-note-selected)' }
        ]}
      />

      <ColorGroup
        title="Surface Borders"
        colors={[
          { name: 'border-subtle', value: 'var(--border-subtle)' },
          { name: 'border-default', value: 'var(--border-default)' },
          { name: 'border-strong', value: 'var(--border-strong)' },
          { name: 'border-taupe', value: 'var(--border-taupe)' },
          { name: 'glass-border', value: 'var(--surface-glass-border)' }
        ]}
      />

      <ColorGroup
        title="Moss (Primary)"
        colors={[
          { name: 'moss-light', value: 'var(--accent-brand-hover)' },
          { name: 'moss', value: 'var(--accent-brand)' },
          { name: 'moss-dark', value: 'var(--accent-brand-pressed)' }
        ]}
      />

      <ColorGroup
        title="Ink (Text)"
        colors={[
          { name: 'ink', value: 'var(--ink-default)' },
          { name: 'ink-accent', value: 'var(--ink-accent)' },
          { name: 'ink-muted', value: 'var(--ink-muted)' },
          { name: 'ink-subtle', value: 'var(--ink-subtle)' },
          { name: 'ink-faint', value: 'var(--ink-faint)' }
        ]}
      />

      <ColorGroup
        title="Status & Semantic"
        colors={[
          { name: 'status-error-surface', value: 'var(--surface-danger-soft)' },
          { name: 'status-error-border', value: 'var(--action-tab-error)' },
          { name: 'status-error-text', value: 'var(--status-error-text)' },
          { name: 'sticky-tab', value: 'var(--accent-sticky-tab)' }
        ]}
      />

      <ColorGroup
        title="Action Tabs - Pending"
        colors={[
          { name: 'action-tab-pending-honey', value: 'var(--action-tab-pending-honey)' },
          { name: 'action-tab-pending-honey-hover', value: 'var(--action-tab-pending-honey-hover)' },
          { name: 'action-tab-pending-cream', value: 'var(--action-tab-pending-cream)' },
          { name: 'action-tab-pending-cream-hover', value: 'var(--action-tab-pending-cream-hover)' },
          { name: 'action-tab-pending-amber', value: 'var(--action-tab-pending-amber)' },
          { name: 'action-tab-pending-amber-hover', value: 'var(--action-tab-pending-amber-hover)' }
        ]}
      />

      <ColorGroup
        title="Action Tabs - Completed"
        colors={[
          { name: 'action-tab-completed-slate', value: 'var(--action-tab-completed-slate)' },
          { name: 'action-tab-completed-slate-hover', value: 'var(--action-tab-completed-slate-hover)' },
          { name: 'action-tab-completed-teal', value: 'var(--action-tab-completed-teal)' },
          { name: 'action-tab-completed-teal-hover', value: 'var(--action-tab-completed-teal-hover)' },
          { name: 'action-tab-completed-periwinkle', value: 'var(--action-tab-completed-periwinkle)' },
          { name: 'action-tab-completed-periwinkle-hover', value: 'var(--action-tab-completed-periwinkle-hover)' }
        ]}
      />

      <ColorGroup
        title="Action Tabs - Error"
        colors={[
          { name: 'action-tab-error', value: 'var(--action-tab-error)' },
          { name: 'action-tab-error-hover', value: 'var(--action-tab-error-hover)' }
        ]}
      />

      <ColorGroup
        title="Action"
        colors={[
          { name: 'action-primary', value: 'var(--action-primary)' },
          { name: 'action-primary-hover', value: 'var(--action-primary)' },
          { name: 'action-primary-ring', value: 'var(--action-primary)' }
        ]}
      />

      <ColorGroup
        title="Accent (Input States)"
        colors={[
          { name: 'accent', value: 'var(--accent-success)' },
          { name: 'accent-light', value: 'var(--accent-success-soft)' },
          { name: 'accent-ring', value: 'var(--accent-success-ring)' }
        ]}
      />

      <ColorGroup
        title="Accents (Semantic)"
        colors={[
          { name: 'accent-terracotta', value: 'var(--accent-terracotta)' },
          { name: 'accent-sage', value: 'var(--accent-sage)' },
          { name: 'accent-clay', value: 'var(--accent-clay)' }
        ]}
      />

      <ColorGroup
        title="Background Colors"
        colors={[
          { name: 'panel-bg', value: 'var(--surface-panel-alt)' },
          { name: 'notes-list-bg', value: 'var(--surface-notes-list)' },
          { name: 'note-selected', value: 'var(--surface-note-selected)' },
          { name: 'note-hover', value: 'var(--surface-note-hover)' },
          { name: 'chat-bg', value: 'var(--surface-chat)' },
          { name: 'chat-message-user', value: 'var(--surface-chat-message-user)' },
          { name: 'chat-message-agent', value: 'var(--surface-chat-message-agent)' },
          { name: 'canvas-bg', value: 'var(--surface-canvas-bg)' },
          { name: 'prompt-bg', value: 'var(--surface-prompt-bg)' },
          { name: 'black-accent', value: 'var(--ink-accent)' }
        ]}
      />
    </div>
  </div>
);

export const Typography: Story = () => (
  <div className="min-h-screen bg-surface-canvas p-8">
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-8 text-h1 text-ink-accent">Typography</h1>

      <div className="mb-12">
        <h2 className="mb-4 text-h2 text-ink-accent">Headings</h2>
        <TypographySample label="Heading 1" className="text-h1" sample="Main Page Heading" />
        <TypographySample label="Heading 2" className="text-h2" sample="Section Heading" />
        <TypographySample label="Heading 3" className="text-h3" sample="Subsection Heading" />
        <TypographySample label="Heading 4" className="text-h4" sample="Component Heading" />
      </div>

      <div className="mb-12">
        <h2 className="mb-4 text-h2 text-ink-accent">Body Text</h2>
        <TypographySample
          label="Body"
          className="text-body"
          sample="This is the standard body text used throughout the application. It provides optimal readability for longer content."
        />
        <TypographySample
          label="Small"
          className="text-small"
          sample="Smaller text for secondary information and UI labels."
        />
        <TypographySample
          label="Caption"
          className="text-caption"
          sample="Caption text for image descriptions and metadata."
        />
        <TypographySample
          label="Micro"
          className="text-micro"
          sample="Very small text for timestamps and fine print."
        />
      </div>

      <div className="mb-12">
        <h2 className="mb-4 text-h2 text-ink-accent">Code & Monospace</h2>
        <TypographySample
          label="Code"
          className="font-mono text-code"
          sample="const greeting = 'Hello, World!';"
        />
        <TypographySample
          label="Inline Code"
          className="text-small"
          sample="Use the <code className='bg-surface-sidebar px-1 py-0.5 rounded font-mono text-code'>useState</code> hook in React components."
        />
      </div>

      <div className="mb-12">
        <h2 className="mb-4 text-h2 text-ink-accent">Font Weights</h2>
        <TypographySample label="Normal (400)" className="text-body font-normal" sample="Normal weight text" />
        <TypographySample label="Medium (500)" className="text-body font-medium" sample="Medium weight text" />
        <TypographySample label="Semibold (600)" className="text-body font-semibold" sample="Semibold weight text" />
        <TypographySample label="Bold (700)" className="text-body font-bold" sample="Bold weight text" />
      </div>

      <div className="mb-12">
        <h2 className="mb-4 text-h2 text-ink-accent">Text Colors</h2>
        <TypographySample label="ink (default)" className="text-body text-ink-default" sample="Default text color" />
        <TypographySample label="ink-accent" className="text-body text-ink-accent" sample="Accent text color for headings" />
        <TypographySample label="ink-muted" className="text-body text-ink-muted" sample="Muted text for secondary content" />
        <TypographySample label="ink-subtle" className="text-body text-ink-subtle" sample="Subtle text for tertiary content" />
        <TypographySample label="ink-faint" className="text-body text-ink-faint" sample="Faint text for timestamps and metadata" />
        <TypographySample label="moss" className="text-body text-accent-brand" sample="Primary brand color text" />
        <TypographySample label="status-error-text" className="text-body text-status-error-text" sample="Error state text" />
      </div>
    </div>
  </div>
);

export const Spacing: Story = () => (
  <div className="min-h-screen bg-surface-canvas p-8">
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-8 text-h1 text-ink-accent">Spacing Scale</h1>

      <div className="space-y-6">
        {[
          { name: 'xs', value: '0.25rem', pixels: '4px' },
          { name: 'sm', value: '0.5rem', pixels: '8px' },
          { name: 'md', value: '1rem', pixels: '16px' },
          { name: 'lg', value: '1.5rem', pixels: '24px' },
          { name: 'xl', value: '2rem', pixels: '32px' },
          { name: '2xl', value: '3rem', pixels: '48px' },
          { name: '3xl', value: '4rem', pixels: '64px' }
        ].map(({ name, value, pixels }) => (
          <div key={name} className="rounded-lg border border-border-subtle bg-ink-inverse p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-mono text-small font-medium text-accent-brand">{name}</span>
              <span className="font-mono text-small text-ink-muted">{value} ({pixels})</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-6 bg-accent-brand" style={{ width: value }} />
              <span className="text-caption text-ink-subtle">Visual representation</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

export const Widths: Story = () => (
  <div className="min-h-screen bg-surface-canvas p-8">
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-8 text-h1 text-ink-accent">Width Tokens</h1>

      <div className="space-y-8">
        <div>
          <h2 className="mb-4 text-h2 text-ink-accent">Panel Widths</h2>
          <div className="space-y-4">
            {[
              { name: 'panel-notes', value: '14rem', pixels: '224px' },
              { name: 'panel-history', value: '17.5rem', pixels: '280px' },
              { name: 'panel-chat', value: '23.75rem', pixels: '380px' },
              { name: 'panel-sticky', value: '4rem', pixels: '64px' }
            ].map(({ name, value, pixels }) => (
              <div key={name} className="rounded-lg border border-border-subtle bg-ink-inverse p-4">
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="font-mono text-small font-medium text-accent-brand">{name}</span>
                  <span className="font-mono text-small text-ink-muted">{value} ({pixels})</span>
                </div>
                <div className="h-8 bg-border-subtle" style={{ width: value }} />
              </div>
            ))}
          </div>
        </div>

        <div>
          <h2 className="mb-4 text-h2 text-ink-accent">Action Tab Widths</h2>
          <div className="space-y-4">
            {[
              { name: 'action-tab-submitted', value: '2.875rem', pixels: '46px' },
              { name: 'action-tab-submitted-hover', value: '3.375rem', pixels: '54px' },
              { name: 'action-tab-draft', value: '2.875rem + 2px', pixels: '48px' },
              { name: 'action-tab-draft-hover', value: '3.375rem + 2px', pixels: '56px' }
            ].map(({ name, value, pixels }) => (
              <div key={name} className="rounded-lg border border-border-subtle bg-ink-inverse p-4">
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="font-mono text-small font-medium text-accent-brand">{name}</span>
                  <span className="font-mono text-small text-ink-muted">{value} ({pixels})</span>
                </div>
                <div className="h-8 bg-accent-sticky-tab" style={{ width: value }} />
              </div>
            ))}
          </div>
        </div>

        <div>
          <h2 className="mb-4 text-h2 text-ink-accent">Max Widths</h2>
          <div className="space-y-4">
            {[
              { name: 'chat-message', value: '80%' },
              { name: 'canvas-compact', value: '48rem', pixels: '768px' },
              { name: 'canvas-content', value: '60rem', pixels: '960px' },
              { name: 'canvas-wide', value: '66rem', pixels: '1056px' },
              { name: 'title-tight', value: '436px' },
              { name: 'title-base', value: '532px' },
              { name: 'title-expanded', value: '628px' },
              { name: 'timeline-max', value: '90%' }
            ].map(({ name, value, pixels }) => (
              <div key={name} className="rounded-lg border border-border-subtle bg-ink-inverse p-4">
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="font-mono text-small font-medium text-accent-brand">{name}</span>
                  <span className="font-mono text-small text-ink-muted">{value}{pixels ? ` (${pixels})` : ''}</span>
                </div>
                {!value.includes('%') && (
                  <div className="h-8 bg-border-subtle" style={{ maxWidth: value, width: '100%' }} />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </div>
);

export const Shadows: Story = () => (
  <div className="min-h-screen bg-surface-canvas p-8">
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-8 text-h1 text-ink-accent">Shadows & Effects</h1>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-lg bg-ink-inverse p-8 text-center shadow-sm">
          <p className="font-mono text-small text-accent-brand">shadow-sm</p>
          <p className="text-caption text-ink-muted">Subtle shadow for cards</p>
        </div>

        <div className="rounded-lg bg-ink-inverse p-8 text-center shadow">
          <p className="font-mono text-small text-accent-brand">shadow</p>
          <p className="text-caption text-ink-muted">Default shadow</p>
        </div>

        <div className="rounded-lg bg-ink-inverse p-8 text-center shadow-md">
          <p className="font-mono text-small text-accent-brand">shadow-md</p>
          <p className="text-caption text-ink-muted">Medium shadow</p>
        </div>

        <div className="rounded-lg bg-ink-inverse p-8 text-center shadow-lg">
          <p className="font-mono text-small text-accent-brand">shadow-lg</p>
          <p className="text-caption text-ink-muted">Large shadow</p>
        </div>

        <div className="col-span-2 rounded-lg bg-ink-inverse p-8 text-center shadow-2xl">
          <p className="font-mono text-small text-accent-brand">shadow-2xl</p>
          <p className="text-caption text-ink-muted">Extra large shadow (used for modals)</p>
        </div>
      </div>

      <h2 className="mb-4 mt-12 text-h2 text-ink-accent">Backdrop Blur</h2>
      <div className="relative h-64 overflow-hidden rounded-lg bg-gradient-to-br from-accent-brand-hover to-accent-brand-pressed p-8">
        <div className="absolute inset-0 bg-surface-canvas" style={{ opacity: 0.3 }} />
        <div className="relative rounded-lg border border-border-subtle bg-ink-inverse/70 p-6 backdrop-blur-sm">
          <p className="font-mono text-small text-accent-brand">backdrop-blur-sm</p>
          <p className="text-small text-ink-default">Used for floating elements like the title bar and prompt box</p>
        </div>
      </div>
    </div>
  </div>
);

export const BorderRadius: Story = () => (
  <div className="min-h-screen bg-surface-canvas p-8">
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-8 text-h1 text-ink-accent">Border Radius</h1>

      <div className="grid grid-cols-2 gap-6">
        {[
          { name: 'rounded (0.25rem)', class: 'rounded' },
          { name: 'rounded-md (0.375rem)', class: 'rounded-md' },
          { name: 'rounded-lg (0.5rem)', class: 'rounded-lg' },
          { name: 'rounded-xl (0.75rem)', class: 'rounded-xl' },
          { name: 'rounded-2xl (1rem)', class: 'rounded-2xl' },
          { name: 'rounded-3xl (1.5rem)', class: 'rounded-3xl' },
          { name: 'rounded-full', class: 'rounded-full' }
        ].map(({ name, class: className }) => (
          <div key={name} className="flex flex-col gap-2">
            <div className={`h-24 border border-border-subtle bg-ink-inverse shadow-sm ${className}`} />
            <p className="text-center font-mono text-small text-accent-brand">{name}</p>
          </div>
        ))}
      </div>
    </div>
  </div>
);

export const Icons: Story = () => {
  const IconDisplay = ({ name, icon: Icon }: { name: string; icon: React.ComponentType<{ className?: string }> }) => (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border-subtle bg-ink-inverse p-4">
      <Icon className="h-6 w-6 text-accent-brand" />
      <span className="text-center font-mono text-micro text-ink-muted">{name}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-surface-canvas p-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-4 text-h1 text-ink-accent">Icons</h1>
        <p className="mb-8 text-body text-ink-muted">
          All icons use Lucide React. Never use emojis in code or UI.
        </p>

        <div className="mb-8 rounded-lg border border-border-subtle bg-ink-inverse p-6">
          <h2 className="mb-4 text-h2 text-ink-accent">Icon Sizes</h2>
          <div className="flex items-end gap-8">
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border border-border-subtle p-4">
                <svg className="h-3 w-3 text-accent-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </div>
              <span className="font-mono text-micro text-ink-muted">h-3 w-3</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border border-border-subtle p-4">
                <svg className="h-4 w-4 text-accent-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </div>
              <span className="font-mono text-micro text-ink-muted">h-4 w-4</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border border-border-subtle p-4">
                <svg className="h-5 w-5 text-accent-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </div>
              <span className="font-mono text-micro text-ink-muted">h-5 w-5</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border border-border-subtle p-4">
                <svg className="h-6 w-6 text-accent-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </div>
              <span className="font-mono text-micro text-ink-muted">h-6 w-6</span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-ink-inverse p-6">
          <h2 className="mb-4 text-h2 text-ink-accent">Common Icons</h2>
          <p className="mb-4 text-small text-ink-muted">
            Reference: <code className="rounded bg-surface-sidebar px-2 py-1 font-mono text-code">lucide-react</code>
          </p>
          <div className="text-small text-ink-subtle">
            <p>Commonly used icons include:</p>
            <ul className="ml-6 mt-2 list-disc space-y-1">
              <li>X, FileText, Circle, CheckCircle2 (timeline viewer)</li>
              <li>Undo2, Redo2, ChevronDown, ChevronUp, ArrowDown (actions)</li>
              <li>Copy, Download, MoreVertical, Pencil, Trash2 (canvas actions)</li>
              <li>Loader2, CornerDownLeft (form states)</li>
              <li>Plus, Search, Settings, User (navigation)</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};
