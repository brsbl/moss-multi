import { createFileRoute } from '@tanstack/react-router';
import { requireSession } from '../host/auth.ts';
import { DevicePage } from '../host/surfaces/DevicePage.tsx';
import { SessionPending } from '../host/surfaces/SessionFrame.tsx';

// /device[?user_code=] (A§4.2, A§7): the CLI's device-flow approval. Signed out it goes to the login card and comes
// back here with the code.
export const Route = createFileRoute('/device')({
  ssr: false,
  // The router parses search values as JSON, so an all-digit code arrives as a number.
  validateSearch: (search: Record<string, unknown>): { user_code?: string } => {
    const code = search.user_code;
    return (typeof code === 'string' && code) || typeof code === 'number' ? { user_code: String(code) } : {};
  },
  beforeLoad: requireSession,
  pendingComponent: SessionPending,
  pendingMinMs: 0,
  component: DeviceRoute,
});

function DeviceRoute() {
  const { user_code } = Route.useSearch();
  return <DevicePage initialCode={user_code ?? ''} />;
}
