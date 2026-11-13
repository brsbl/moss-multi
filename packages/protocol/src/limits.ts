// Per-doc limits (A§5.1, A§18; P:Tech "1.02 million characters per note, 50 connections").

/**
 * The product limit (owner ruling 2026-10-28, Google Docs' "up to 1.02 million characters"): the characters of text a
 * note holds, as JavaScript string length (UTF-16 code units), over every text run of its body and the text of every
 * payload it names (code, HTML, formula). Not markdown bytes, not markup.
 */
export const TEXT_CHAR_CAP = 1_020_000;

/**
 * The structure guard: the Yjs structs a note's doc and its named payload docs hold, live, deleted and collected alike,
 * so edit history counts too. Each struct costs the DocDO about 250 bytes of heap; at this cap a note in any shape
 * creates, wakes, saves and exports under a 96 MB heap with 10% to spare (the `memory` CI job). About 36,000 one-line
 * paragraphs (5 structs each, A§10.11), 30,000 list items (6) or 11,000 two-column table rows (16).
 */
export const STRUCT_CAP = 180_000;

/** The most a UTF-16 code unit encodes to in UTF-8 (a surrogate pair is 4 bytes for 2 units). */
const UTF8_BYTES_PER_CHAR = 3;

/**
 * Encoded state bytes per struct, beyond its text, that a note within the caps may need: ids, origins, parents and
 * property keys and values (SP2 for the lean layout: the `memory` job's notes at the caps encode at about 20 bytes a
 * struct and holds every shape under this).
 */
export const STATE_BYTES_PER_STRUCT = 64;

/**
 * The storage bound every entry point also checks: the encoded state of the note plus every stored payload. Derived from
 * the two caps with a quarter to spare, so a note within them is always typeable and never meets this first.
 */
export const STATE_CAP_BYTES = Math.round((TEXT_CHAR_CAP * UTF8_BYTES_PER_CHAR + STRUCT_CAP * STATE_BYTES_PER_STRUCT) * 1.25);

/**
 * The longest markdown a create reads: room for TEXT_CHAR_CAP characters of any script and their markup. A transport
 * bound only: the note's limits are counted on what the import makes.
 */
export const MARKDOWN_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The largest frame a client sends on a doc socket (T3.S6). Larger updates go as pieces; a paste that would need a
 * larger piece (one block's text past it) is refused whole. The DocDO closes a socket with 2 MiB waiting (1013).
 */
export const CLIENT_FRAME_MAX_BYTES = 1024 * 1024;

/**
 * The DocDO answers a step 1 in frames of about this many bytes (T3.S6b): a frame of megabytes reads as silence on the
 * client for as long as it takes to arrive, and its heartbeat closes a silent socket after 12 s.
 */
export const ANSWER_PIECE_BYTES = 256 * 1024;

export const MAX_CONNECTIONS = 50;

/** Writes per connection per window; the overflow frame is not applied and the socket closes 4420. */
export const WRITE_RATE = { max: 300, windowMs: 5_000 } as const;

/**
 * Full-state answers (a step 1 for the note or a payload) per principal per doc, or per share link and client address
 * for anonymous viewers (T3.S14, T3.B25): `docs` whole states' worth at once, refilled over `windowMs`; each answer
 * costs the share of the stored state it sends. Past it a socket's latest step 1 per target waits for the refill, so a
 * reconnect is late, never unanswered, and never refills it.
 */
export const ANSWER_BUDGET = { docs: 8, windowMs: 20_000 } as const;

/** Open anonymous sockets per doc from one share link and client address; past it a socket closes 4429 (T3.B25). */
export const ANONYMOUS_SOCKETS_PER_ADDRESS = 8;

export const AWARENESS_MAX_BYTES = 8 * 1024;

/** Display names in a socket's attachment. */
export const NAME_MAX_CHARS = 80;

/** Acks to one connection coalesce over this window. */
export const ACK_COALESCE_MS = 250;

/** REST writes (a rename now, a push later) per principal per window, counted by its PrincipalDO (A§5.2); 429 past it. */
export const REST_WRITE_RATE = { max: 60, windowMs: 60_000 } as const;

/**
 * Notes minted (created, imported or duplicated) per acting user per window, counted by their PrincipalDO before any
 * row or DocDO (A§5.2, A§18); an agent key counts against its owner. 429 past it. The heaviest journey mints well under
 * ten a minute per principal, and a person filing notes by hand far fewer.
 */
export const DOC_CREATE_RATE = { max: 60, windowMs: 60_000 } as const;

/**
 * Notes minted per acting user per day, on the same PrincipalDO, counting only the ones granted; 429 past it. A person
 * importing a large vault at the minute rate takes about half an hour for 2,000, which no journey or seed comes near.
 */
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DOC_CREATE_DAILY = { max: 2_000, windowMs: DAY_MS } as const;

/** The largest `POST /api/docs` body: MARKDOWN_MAX_BYTES even if JSON escapes every byte (`\u00XX`), plus the fields. */
export const CREATE_BODY_MAX_BYTES = MARKDOWN_MAX_BYTES * 6 + 64 * 1024;

/**
 * Live (untrashed) notes one acting user has created, wherever they are and their agents' included; a create or
 * duplicate past it is 409 (A§18). Charged to the creator, never the vault, so a collaborator cannot fill an owner's.
 */
export const LIVE_NOTE_CAP = 10_000;

/** Folders and vaults one acting user (with their agents) creates per day, in any vault; 429 past it (A§18). */
export const FOLDER_CREATE_DAILY = 1_000;

/** Agent keys one person mints per day, revoked ones included; 429 past it (A§18). */
export const AGENT_KEY_DAILY = 50;

/** Share links one person makes per day, over every target, revoked ones included; 429 past it (A§18). */
export const SHARE_LINK_DAILY = 50;

/** Feedback messages one person sends per day; 429 past it (A§18). */
export const FEEDBACK_DAILY = 20;

/** Media uploads (and cross-note copies) per identity per window, counted by a PrincipalDO (A§16); 429 past it. A
 * signed-in holder of a link is also counted under the link and their IP, whichever account they use. */
export const UPLOAD_RATE = { max: 60, windowMs: 60_000 } as const;

/** Uploaded media bytes a vault can hold, summed over the assets uploaded into its folders; 413 past it. */
export const VAULT_MEDIA_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

/** Server fetches of caller-supplied URLs (unfurls, remote images) per identity per window; 429 past it (A§18). */
export const REMOTE_FETCH_RATE = { max: 30, windowMs: 60_000 } as const;

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
