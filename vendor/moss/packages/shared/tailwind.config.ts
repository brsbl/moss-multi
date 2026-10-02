// ported-from: packages/shared/tailwind.config.ts @ 762abb777
import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';
import containerQueries from '@tailwindcss/container-queries';
import { tokenColors, tokenVars } from './src/themes';

const semanticColors = {
  transparent: 'transparent',
  current: 'currentColor',
  ...tokenColors
};

const semanticColorVars = tokenVars;

const typographyTheme = () => ({
  DEFAULT: {
    css: {
      maxWidth: 'none',
      color: semanticColorVars['ink-default'],
      h1: {
        color: semanticColorVars['ink-accent'],
        fontWeight: '600',
        fontSize: '1.875rem',
        marginTop: '0',
        marginBottom: '1.5rem'
      },
      h2: {
        color: semanticColorVars['ink-accent'],
        fontWeight: '600',
        fontSize: '1.5rem',
        marginTop: '2.5rem',
        marginBottom: '1.25rem'
      },
      h3: {
        color: semanticColorVars['ink-accent'],
        fontWeight: '600',
        fontSize: '1.25rem',
        marginTop: '2rem',
        marginBottom: '1rem'
      },
      p: {
        marginTop: '0.5rem',
        marginBottom: '0.5rem'
      },
      strong: {
        color: semanticColorVars['ink-accent'],
        fontWeight: '600'
      },
      'ul, ol': {
        marginTop: '0.5rem',
        marginBottom: '0.5rem',
        paddingLeft: '1.5rem'
      },
      li: {
        marginTop: '0.25rem',
        marginBottom: '0.25rem'
      },
      table: {
        width: '100%',
        marginTop: '1.5rem',
        marginBottom: '1.5rem',
        borderCollapse: 'collapse',
        border: `1px solid ${semanticColorVars['border-subtle']}`,
        borderRadius: '0.5rem',
        overflow: 'hidden'
      },
      thead: {
        backgroundColor: semanticColorVars['surface-canvas'],
        borderBottom: `1px solid ${semanticColorVars['border-subtle']}`
      },
      'thead th': {
        padding: '0.75rem 1rem',
        textAlign: 'left',
        fontWeight: '600',
        color: semanticColorVars['ink-accent'],
        fontSize: '0.875rem'
      },
      'tbody tr': {
        borderBottom: `1px solid ${semanticColorVars['border-subtle']}`
      },
      'tbody tr:last-child': {
        borderBottom: 'none'
      },
      'tbody td': {
        padding: '0.75rem 1rem',
        fontSize: '0.875rem',
        color: semanticColorVars['ink-default']
      },
      code: {
        color: semanticColorVars['ink-subtle'],
        fontSize: '0.875rem',
        fontFamily: 'JetBrains Mono, monospace',
        backgroundColor: semanticColorVars['surface-code'],
        padding: '0.125rem 0.375rem',
        borderRadius: '0.25rem',
        fontWeight: '400'
      },
      'code::before': {
        content: '""'
      },
      'code::after': {
        content: '""'
      }
    }
  },
  moss: {
    css: {
      '--tw-prose-body': semanticColorVars['ink-default'],
      '--tw-prose-headings': semanticColorVars['ink-accent'],
      '--tw-prose-lead': semanticColorVars['ink-muted'],
      '--tw-prose-links': semanticColorVars['accent-brand'],
      '--tw-prose-bold': semanticColorVars['ink-accent'],
      '--tw-prose-counters': semanticColorVars['ink-subtle'],
      '--tw-prose-bullets': semanticColorVars['border-default'],
      '--tw-prose-hr': semanticColorVars['border-subtle'],
      '--tw-prose-quotes': semanticColorVars['ink-accent'],
      '--tw-prose-quote-borders': semanticColorVars['border-default'],
      '--tw-prose-captions': semanticColorVars['ink-subtle'],
      '--tw-prose-code': semanticColorVars['ink-subtle'],
      '--tw-prose-pre-code': semanticColorVars['ink-default'],
      '--tw-prose-pre-bg': semanticColorVars['surface-code'],
      '--tw-prose-th-borders': semanticColorVars['border-default'],
      '--tw-prose-td-borders': semanticColorVars['border-subtle']
    }
  }
});

const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
    '../desktop/src/renderer/**/*.{ts,tsx,html}',
    '../desktop/stories/**/*.{ts,tsx,js,jsx,html}',
    '../web/src/**/*.{ts,tsx,html}'
  ],
  theme: {
    colors: semanticColors,
    typography: typographyTheme,
    extend: {
      screens: {
        'lgx': '1152px',
        '3xl': '2000px'
      },
      zIndex: {
        'dialog-overlay': '120',
        'dialog-content': '130',
        'nested-overlay': '140',
        'nested-content': '150',
        'typeahead': '160',
        'tooltip': '170'
      },
      width: {
        'panel-notes': '14rem',
        'panel-history': '17.5rem',
        'panel-actions': '17.5rem',
        'panel-chat': '23.75rem',
        'panel-sticky': '4rem',
        'action-tab-submitted': '2.875rem',
        'action-tab-submitted-hover': '3.125rem',
        'action-tab-draft': 'calc(2.875rem + 2px)',
        'action-tab-draft-hover': 'calc(3.125rem + 2px)',
        'floating-toolbar': '15.625rem',
        'timeline-width': '700px',
        'floating-nav': '11rem',
        'web-embed-popover': '21.25rem',
        'comment-input-popover': '18rem',
        'comment-thread-popover': '22rem',
        'comment-list-popover': '22rem',
        'comment-gutter-target': '2.25rem'
      },
      height: {
        'story-viewport': '42.5rem'
      },
      maxHeight: {
        'timeline': '600px',
        'folder-list': '500px',
        'folder-section': '40vh',
        'folder-notes': '25vh',
        'folder-group-notes': '7.5rem',
        'streaming-content': '200px',
        'canvas-image': '32rem',
        'modal-body': '60vh',
        'modal': '85vh',
        'comment-list': 'min(56vh, 420px)',
        'comment-list-popover': '60vh',
        'comment-thread-viewport': 'min(64vh, 520px)'
      },
      minHeight: {
        'drop-zone': '7.5rem'
      },
      maxWidth: {
        'modal': '480px',
        'chat-message': '80%',
        'tweet-embed': '460px',
        'canvas-mobile': '40rem',
        'canvas-tablet': '48rem',
        'canvas-compact': '56rem',
        'canvas-prose': '53.125rem',
        'canvas-readable': '61rem',
        'canvas-blocks': '68rem',
        'canvas-content': '64rem',
        'canvas-comfortable': '72rem',
        'canvas-expanded': '80rem',
        'canvas-wide': '88rem',
        'title-tight': '436px',
        'title-base': '532px',
        'title-expanded': '628px',
        'title-ultra': '50rem',
        'timeline-max': '90%',
        'timeline-width': '700px',
        'error-message': '12rem',
        'floating-popover-viewport': 'calc(100vw - 2rem)'
      },
      minWidth: {
        'title-tight': '14rem',
        'title-base': '18rem',
        'title-expanded': '22rem',
        'title-ultra': '30rem',
        'title-bar': '17.5rem'
      },
      inset: {
        '1/5': '20%'
      },
      gap: {
        'floating-bar': '1rem'
      },
      translate: {
        'comment-gutter': 'calc(100% + 1.5rem)'
      },
      boxShadow: {
        surface: '0 8px 24px var(--surface-fn-rgba726760008)',
        floating: '0 -1px 6px var(--surface-fn-rgba0000025), 0 1px 6px var(--surface-fn-rgba0000025)'
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--collapsible-panel-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--collapsible-panel-height)' },
          to: { height: '0' }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 150ms ease-out',
        'accordion-up': 'accordion-up 150ms ease-out'
      },
      transitionProperty: {
        width: 'width'
      },
      borderWidth: {
        '3': '3px'
      },
      fontFamily: {
        sans: ['Inter Variable', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'ui-monospace', 'monospace']
      },
      fontWeight: {
        book: '350',
        normal: '400',
        medium: '500',
        semibold: '600',
        bold: '700'
      },
      spacing: {
        xs: '0.25rem',
        sm: '0.5rem',
        md: '1rem',
        lg: '1.5rem',
        xl: '2rem',
        '2xl': '3rem',
        '3xl': '4rem',
        'tab-stack-offset': '30px',
        'action-card-sticky': '73px',
        'canvas-gutter': '4rem',
        'canvas-surface-pad': '0.75rem',
        'panel-inset': '16px',
        'panel-drag-top': '0.5rem',      // 8px — drag region top; centers h-8 content row on traffic lights (8px + 16px = 24px)
        'panel-bar-bottom': '0.5rem',    // 8px — toolbar bottom padding
        'canvas-body-top': '1rem',       // 16px — canvas body top padding (aligns with notes list panel content)
        'panel-section-gap': '0.75rem',   // 12px — vertical rhythm between panel sections
        'canvas-bar-inset': '1.5rem',     // 24px — canvas header/footer/content horizontal padding
        'sidebar-row-x': '0.5rem',       // 8px — horizontal padding for sidebar rows (folders, notes)
        'sidebar-row-y': '0.25rem',      // 4px — vertical padding for sidebar rows
        'sidebar-row-gap': '0.25rem',    // 4px — gap between icon and text in sidebar rows
        'sidebar-folder-header': '25px', // folder header row height: 2 × sidebar-row-y (8px) + text-caption line (17px)
        'sidebar-indent': '0.75rem',     // 12px — tree-line indent (ml) for nested content
        'sidebar-list-gap': '0.125rem',  // 2px — gap between items in a list
        'sidebar-icon-col': '1.25rem'    // 20px — per-level indent step = icon w-4 (16px) + sidebar-row-gap (4px)
      },
      fontSize: {
        h1: ['28px', { lineHeight: '36px', fontWeight: '600' }],
        h2: ['22px', { lineHeight: '28px', fontWeight: '600' }],
        h3: ['18px', { lineHeight: '26px', fontWeight: '600' }],
        h4: ['16px', { lineHeight: '23px', fontWeight: '600' }],
        body: ['15px', { lineHeight: '23px', fontWeight: '400' }],
        small: ['14px', { lineHeight: '1.5', fontWeight: '400' }],
        caption: ['12px', { lineHeight: '1.4', fontWeight: '400' }],
        code: ['13px', { lineHeight: '20px', fontWeight: '400' }],
        detail: ['13px', { lineHeight: '1.25rem', fontWeight: '400' }],
        micro: ['11px', { lineHeight: '1rem', fontWeight: '400' }],
        nano: ['10px', { lineHeight: '0.875rem', fontWeight: '400' }]
      },
      letterSpacing: {
        title: '-0.025em'
      }
    }
  },
  plugins: [typography, containerQueries]
};

export default config;
