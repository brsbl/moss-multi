// This tab's one notices store (notifications.ts), tied to its auth: signing out or an ended session empties the bell
// in the same tick, and a sign-in reads it again (L§4.6 background work after sign-out).
import { auth } from './auth.ts';
import { createNotifications } from './notifications.ts';

export const inbox = createNotifications({
  fetch: (input, init) => fetch(input, init),
  signedIn: () => auth.get().status === 'signed-in',
});

if (typeof window !== 'undefined') {
  let was = auth.get().status;
  auth.subscribe((state) => {
    if (state.status !== 'signed-in') inbox.clear();
    else if (was !== 'signed-in') void inbox.refresh();
    was = state.status;
  });
}
