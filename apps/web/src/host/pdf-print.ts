// Save as PDF is browser print (R4; A§4.2): moss's PdfExportApp marks body[data-pdf-export-status] `ready` once the
// note and its resources have rendered, and the /pdf-export tab then opens the print dialog once. `error` leaves
// PdfExportApp's own message on the page with no dialog.
import { setAppState } from './app-state.ts';

const STATUS = 'data-pdf-export-status';
let printed = false;

/** Prints once when the status turns `ready`; returns the observer's stop. */
export function printWhenReady(print: () => void = () => window.print()): () => void {
  const settle = (): boolean => {
    const status = document.body.getAttribute(STATUS);
    if (status !== 'ready' && status !== 'error') return false;
    setAppState('ready');
    if (status === 'ready' && !printed) {
      printed = true;
      print();
    }
    return true;
  };
  if (settle()) return () => undefined;
  const observer = new MutationObserver(() => {
    if (settle()) observer.disconnect();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: [STATUS] });
  return () => observer.disconnect();
}
