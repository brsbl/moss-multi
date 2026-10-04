import { createFileRoute } from '@tanstack/react-router';
import { MossAppHost } from '../host/MossAppHost.tsx';

// Save as PDF (R4; A§4.2): the tab that "Save as PDF" opens. moss's PdfExportApp renders the note from the session
// its opener left in session storage and calls window.print once ready (host/pdf-print.ts). The note comes from that
// session, not the server, so the route asks for no sign-in; media loads with whatever access the browser holds.
export const Route = createFileRoute('/pdf-export')({
  ssr: false,
  component: MossAppHost,
});
