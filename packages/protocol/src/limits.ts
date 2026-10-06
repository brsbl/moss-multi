// Per-doc limits (A§5.1, A§18; P:Tech "2 MB/doc, 50 connections").

/** PRODUCT's 2 MB is the markdown a doc can hold. */
export const MARKDOWN_CAP_BYTES = 2 * 1024 * 1024;

/**
 * State-to-markdown ratio r (SP2). The scale note measures about 10.5; a canvas alone about 47. The value is
 * provisional until the SP2 ruling recorded in METHOD.md.
 */
export const STATE_RATIO = 10.5;

/** Every entry point checks the encoded doc state against this, so a doc under 2 MB of markdown stays typeable. */
export const STATE_CAP_BYTES = Math.round(MARKDOWN_CAP_BYTES * STATE_RATIO * 1.25);

export const MAX_CONNECTIONS = 50;

/** Writes per connection per window; the overflow frame is not applied and the socket closes 4420. */
export const WRITE_RATE = { max: 300, windowMs: 5_000 } as const;

export const AWARENESS_MAX_BYTES = 8 * 1024;

/** Display names in a socket's attachment. */
export const NAME_MAX_CHARS = 80;

/** Acks to one connection coalesce over this window. */
export const ACK_COALESCE_MS = 250;

/** REST writes (a rename now, a push later) per principal per window, counted by its PrincipalDO (A§5.2); 429 past it. */
export const REST_WRITE_RATE = { max: 60, windowMs: 60_000 } as const;

/** Media uploads (and cross-note copies) per identity per window, counted by a PrincipalDO (A§16); 429 past it. A
 * signed-in holder of a link is also counted under the link and their IP, whichever account they use. */
export const UPLOAD_RATE = { max: 60, windowMs: 60_000 } as const;

/** Uploaded media bytes a vault can hold, summed over the assets uploaded into its folders; 413 past it. */
export const VAULT_MEDIA_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

/** Server fetches of caller-supplied URLs (unfurls, remote images) per identity per window; 429 past it (A§18). */
export const REMOTE_FETCH_RATE = { max: 30, windowMs: 60_000 } as const;

/** Comment operations (create, reply, later edit, resolve, react) per principal per window, counted by its PrincipalDO; 429 past it. */
export const COMMENT_OP_RATE = { max: 60, windowMs: 60_000 } as const;

/**
 * How long a PrincipalDO remembers an ended session and a session's doc sockets (A§5.2): better-auth's default session
 * lifetime, 7 days, which no in-flight upgrade outlives.
 */
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The longest a doc socket stays open (A§5.1): the DocDO closes it 1013 at this age, from when its role was resolved,
 * and it reconnects and registers afresh. A day short of SESSION_MAX_MS, so the PrincipalDO never prunes a registry
 * row whose socket is still open.
 */
export const DOC_SOCKET_MAX_MS = SESSION_MAX_MS - 24 * 60 * 60 * 1000;

/**
 * While frames flow, a DocDO or PrincipalDO re-validates its sockets' access at most this long after the last frame
 * (A§8 pull validation), so a socket that sends nothing still closes once its access is gone. An idle DO stops ticking
 * and hibernates; its next frame validates first.
 */
export const ACCESS_TICK_MS = 5_000;

/**
 * The longest a DocDO or PrincipalDO waits for D1 to answer a validation (A§8, L§4.7): past it the validation fails
 * closed, and the sockets waiting on it close 1013 and reconnect.
 */
export const ACCESS_DEADLINE_MS = 5_000;
