import { createFileRoute } from '@tanstack/react-router';
import { MossAppHost } from '../host/MossAppHost.tsx';

// The moss shell with the doc open: the bridge hands $docId to App as its window-context startup note (A§4.2).
export const Route = createFileRoute('/d/$docId')({
  component: MossAppHost,
});
