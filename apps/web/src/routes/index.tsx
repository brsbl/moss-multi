import { createFileRoute } from '@tanstack/react-router';
import { MossAppHost } from '../host/MossAppHost.tsx';

// The moss shell on the active vault (A§4.2); T0.5b's bridge adds the last-viewed doc.
export const Route = createFileRoute('/')({
  component: MossAppHost,
});
