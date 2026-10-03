import { createFileRoute, redirect } from '@tanstack/react-router';
import { loginProviders, lookupSession } from '../auth/session-fn.ts';
import { asSessionAnswer, safeNext } from '../host/auth-state.ts';
import { LoginCard } from '../host/surfaces/LoginCard.tsx';

// /login[?next=] (A§4.2): the card renders on the server for a fast first paint. Someone already signed in goes
// straight to `next`; a lookup that fails still shows the card, whose own requests then say what is wrong.
export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { next?: string } => (typeof search.next === 'string' ? { next: search.next } : {}),
  beforeLoad: async ({ search }) => {
    const answer = asSessionAnswer(await lookupSession().catch(() => null));
    if (answer.kind === 'signed-in') throw redirect({ href: safeNext(search.next), replace: true });
  },
  loader: () => loginProviders().catch(() => []),
  component: LoginRoute,
});

function LoginRoute() {
  const { next } = Route.useSearch();
  return <LoginCard next={safeNext(next)} providers={Route.useLoaderData()} />;
}
