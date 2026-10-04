// ported-from: .ladle/components.tsx @ 762abb777
import type { ReactNode } from 'react';
import { useEffect } from 'react';

// Set up the global `Prism` before any `@lexical/code` module evaluates — the
// app does this at its entry (main.tsx). Stories that render the editor or the
// comment composer pull in `@lexical/code`, which throws "Prism is not defined"
// without it. Must come before component/style imports.
import '../packages/desktop/src/renderer/editor/plugins/code-block/prism-setup';
import '../packages/desktop/src/renderer/styles.css';

// Inject global CSS to override width constraints ONLY in story iframe
// This must execute synchronously before React renders
if (typeof document !== 'undefined' && window.self !== window.top) {
  // We're inside an iframe (story preview), not the main Ladle UI
  const style = document.createElement('style');
  style.setAttribute('data-ladle-story-override', 'true');
  style.textContent = `
    /* Force full width for story content only (inside iframe) */
    html, body, #ladle-root {
      width: 100% !important;
      max-width: none !important;
      min-width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      box-sizing: border-box !important;
      height: 100% !important;
      overflow: hidden !important;
    }

    /* Ensure AppShell gets full viewport */
    .flex.h-full.min-h-screen {
      width: 100vw !important;
      height: 100vh !important;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Ladle Provider - matches app environment exactly
 *
 * IMPORTANT: Stories must render identically to the actual app.
 * This provider ensures the story iframe has the same styles and dimensions.
 */
export const Provider = ({ children }: { children: ReactNode }) => {
  useEffect(() => {
    // Add viewport meta tag to ensure proper responsive breakpoint detection
    let viewportMeta = document.querySelector('meta[name="viewport"]');
    if (!viewportMeta) {
      viewportMeta = document.createElement('meta');
      viewportMeta.setAttribute('name', 'viewport');
      viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1.0');
      document.head.appendChild(viewportMeta);
    }

    // Aggressively enforce full width on all containers
    const enforceFullWidth = () => {
      const selectors = [
        'html',
        'body',
        '#ladle-root',
        '[data-storyloaded]',
        '.flex.h-full.min-h-screen'
      ];

      selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el instanceof HTMLElement) {
            el.style.width = '100%';
            el.style.minWidth = '100%';
            el.style.maxWidth = 'none';
            el.style.margin = '0';
            el.style.padding = '0';
          }
        });
      });

      document.documentElement.style.height = '100%';
      document.body.style.height = '100%';
      document.body.style.overflow = 'hidden';

      const ladleRoot = document.getElementById('ladle-root');
      if (ladleRoot) {
        ladleRoot.style.height = '100vh';
      }
    };

    // Initial enforcement
    enforceFullWidth();

    // Watch for DOM changes and re-enforce
    const observer = new MutationObserver(() => {
      enforceFullWidth();
      window.dispatchEvent(new Event('resize'));
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });

    // Also enforce on window resize
    const handleResize = () => {
      enforceFullWidth();
    };
    window.addEventListener('resize', handleResize);

    // Force initial media query evaluation
    const forceReflow = () => {
      void document.body.offsetHeight;
      window.dispatchEvent(new Event('resize'));
    };

    requestAnimationFrame(() => {
      forceReflow();
      setTimeout(forceReflow, 0);
      setTimeout(forceReflow, 100);
      setTimeout(forceReflow, 300);
    });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return <>{children}</>;
};
