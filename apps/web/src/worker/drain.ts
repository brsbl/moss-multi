// workerd may close a keep-alive connection whose request body the response left unread (a refusal answered before
// parsing), and wrangler's dev proxy then loses the next request it writes there: a 503 for a POST or DELETE, which
// it no longer replays (T3.B22). A small unread body is read to the end before answering; a large one is left.
export const DRAIN_LIMIT = 65_536;

export async function drainUnreadBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  if (Number(request.headers.get('content-length') ?? Infinity) > DRAIN_LIMIT) return;
  await request.arrayBuffer().catch(() => null);
}
