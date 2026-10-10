// D1 schema (A§6). better-auth's tables use timestamp_ms columns; app tables hold plain epoch-ms integers
// (the bridge converts to seconds). Migrations are generated from this file: `pnpm --filter web db:generate`.
import { sql } from 'drizzle-orm';
import {
  check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
// Roles from the one roles module: links stop at editor; a grant or invite may make a co-owner (the vault owner
// itself is never stored, it derives from owner_user_id).
import { GRANT_ROLES, MEMBER_ROLES } from '@moss-multi/protocol/roles';

const now = () => new Date();

// ---------- better-auth ----------

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** The deviceAuthorization plugin's rows (CLI login, A§17). */
export const deviceCode = sqliteTable(
  'device_code',
  {
    id: text('id').primaryKey(),
    deviceCode: text('device_code').notNull(),
    userCode: text('user_code').notNull(),
    userId: text('user_id'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    status: text('status').notNull(),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp_ms' }),
    pollingInterval: integer('polling_interval'),
    clientId: text('client_id'),
    scope: text('scope'),
  },
  (t) => [index('device_code_device_code_idx').on(t.deviceCode), index('device_code_user_code_idx').on(t.userCode)],
);

/** better-auth's database rate-limit store (A§7); lastRequest is epoch ms. */
export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
});

// ---------- moss-multi ----------

const PRINCIPAL_TYPES = ['user', 'agent'] as const;
const TARGET_TYPES = ['doc', 'folder'] as const;

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** sha256 hex of the full `mm_sk_…` key; the key itself is never stored. */
    keyHash: text('key_hash').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  // Owner and creation time serve both an owner's agents and their daily mint bound (A§18).
  (t) => [index('agents_owner_idx').on(t.ownerUserId, t.createdAt)],
);

/** Vaults are the root folders: parent_id IS NULL exactly when kind = 'vault'. */
export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['folder', 'vault'] }).notNull().default('folder'),
    parentId: text('parent_id').references((): AnySQLiteColumn => folders.id, { onDelete: 'cascade' }),
    deletedAt: integer('deleted_at'),
    trashBatchId: text('trash_batch_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('folders_owner_idx').on(t.ownerUserId),
    index('folders_parent_idx').on(t.parentId),
    // The creator's daily folder bound (A§18).
    index('folders_created_by_idx').on(t.createdBy, t.createdAt),
    uniqueIndex('folders_vault_name_unique')
      .on(t.ownerUserId, sql`lower(name)`)
      .where(sql`kind = 'vault' AND deleted_at IS NULL`),
    // moss identifies folders by path, so live sibling names are unique case-insensitively.
    uniqueIndex('folders_parent_name_unique')
      .on(t.parentId, sql`lower(name)`)
      .where(sql`parent_id IS NOT NULL AND deleted_at IS NULL`),
    check('folders_vault_is_root', sql`(kind = 'vault') = (parent_id IS NULL)`),
  ],
);

export const docs = sqliteTable(
  'docs',
  {
    id: text('id').primaryKey(),
    /** The vault owner, also for docs an editor created in a shared vault (created_by records the creator). */
    ownerUserId: text('owner_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull(),
    folderId: text('folder_id').notNull().references(() => folders.id, { onDelete: 'cascade' }),
    /** DocDO projections of Y.Text('title') (A§5.1); nothing else writes them. */
    title: text('title').notNull().default(''),
    filename: text('filename').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    trashBatchId: text('trash_batch_id'),
  },
  (t) => [
    index('docs_owner_deleted_idx').on(t.ownerUserId, t.deletedAt),
    index('docs_folder_idx').on(t.folderId),
    // The creator's live-note cap (A§18).
    index('docs_created_by_idx').on(t.createdBy, t.deletedAt),
    uniqueIndex('docs_folder_filename_unique').on(t.folderId, t.filename).where(sql`deleted_at IS NULL`),
  ],
);

export const docMembers = sqliteTable(
  'doc_members',
  {
    docId: text('doc_id').notNull().references(() => docs.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    principalType: text('principal_type', { enum: PRINCIPAL_TYPES }).notNull(),
    role: text('role', { enum: GRANT_ROLES }).notNull(),
    addedBy: text('added_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.docId, t.principalId] }), index('doc_members_principal_idx').on(t.principalId)],
);

/** Folder grants; a vault grant is a row on the vault. */
export const folderMembers = sqliteTable(
  'folder_members',
  {
    folderId: text('folder_id').notNull().references(() => folders.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    principalType: text('principal_type', { enum: PRINCIPAL_TYPES }).notNull(),
    role: text('role', { enum: GRANT_ROLES }).notNull(),
    addedBy: text('added_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.principalId] }), index('folder_members_principal_idx').on(t.principalId)],
);

export const shareLinks = sqliteTable(
  'share_links',
  {
    /** 24 random bytes, hex. */
    token: text('token').primaryKey(),
    targetType: text('target_type', { enum: TARGET_TYPES }).notNull(),
    targetId: text('target_id').notNull(),
    role: text('role', { enum: MEMBER_ROLES }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('share_links_target_idx').on(t.targetType, t.targetId), index('share_links_created_by_idx').on(t.createdBy, t.createdAt)],
);

export const invites = sqliteTable(
  'invites',
  {
    token: text('token').primaryKey(),
    /** Stored trimmed and lowercased. */
    email: text('email').notNull(),
    targetType: text('target_type', { enum: TARGET_TYPES }).notNull(),
    targetId: text('target_id').notNull(),
    role: text('role', { enum: GRANT_ROLES }).notNull(),
    invitedBy: text('invited_by').notNull(),
    createdAt: integer('created_at').notNull(),
    acceptedAt: integer('accepted_at'),
    acceptedBy: text('accepted_by'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('invites_email_idx').on(t.email),
    index('invites_target_idx').on(t.targetType, t.targetId),
    index('invites_inviter_idx').on(t.invitedBy, t.createdAt),
    // One open invite per email and target, so two shares of one email at once leave one row (T2.4).
    uniqueIndex('invites_open_idx').on(t.targetType, t.targetId, t.email).where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['mention', 'comment-reply', 'share-invite', 'suggestion', 'invite-accepted'] }).notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
  },
  (t) => [index('notifications_user_read_idx').on(t.userId, t.readAt)],
);

/** Folder-scoped media; bytes are content-addressed in R2 through asset_versions. */
export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    folderId: text('folder_id').notNull().references(() => folders.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    kind: text('kind', { enum: ['image', 'video'] }).notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    currentVersionId: text('current_version_id').references((): AnySQLiteColumn => assetVersions.id, {
      onDelete: 'set null',
    }),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('assets_folder_filename_unique').on(t.folderId, t.filename)],
);

export const contentObjects = sqliteTable('content_objects', {
  /** sha256 hex; the blob is at asset-blobs/sha256/<hash> in R2. */
  hash: text('hash').primaryKey(),
  size: integer('size').notNull(),
  refcount: integer('refcount').notNull(),
});

export const assetVersions = sqliteTable(
  'asset_versions',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull().references(() => contentObjects.hash),
    size: integer('size').notNull(),
    etag: text('etag').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
    message: text('message'),
  },
  (t) => [index('asset_versions_asset_idx').on(t.assetId), index('asset_versions_content_hash_idx').on(t.contentHash)],
);

/**
 * A doc's media (A§16): each `assets/<filename>` the doc uses, bound to the immutable bytes an upload into it, a copy
 * from a doc the copier reads, or a duplicate placed there. Reads resolve only through this record, never by filename
 * in a folder; a move keeps it as it is.
 */
export const docMedia = sqliteTable(
  'doc_media',
  {
    docId: text('doc_id').notNull().references(() => docs.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    versionId: text('version_id').references(() => assetVersions.id, { onDelete: 'set null' }),
    contentHash: text('content_hash').notNull().references(() => contentObjects.hash),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.docId, t.filename] })],
);

export const userPrefs = sqliteTable('user_prefs', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  defaultVaultId: text('default_vault_id').references(() => folders.id, { onDelete: 'set null' }),
  /** NULL means moss's default. */
  noteIntelligence: integer('note_intelligence', { mode: 'boolean' }),
});

/** Per-user doc preferences: a pin never pins for anyone else. */
export const userDocPrefs = sqliteTable(
  'user_doc_prefs',
  {
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    docId: text('doc_id').notNull().references(() => docs.id, { onDelete: 'cascade' }),
    pinnedAt: integer('pinned_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.docId] })],
);

/** moss's Feedback dialog writes here, so it is not a dead affordance. */
export const feedback = sqliteTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    page: text('page'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('feedback_created_idx').on(t.createdAt), index('feedback_user_idx').on(t.userId, t.createdAt)],
);

/**
 * Each vault owner's access epoch (A§8 pull validation): triggers in the migration bump it in the same statement as
 * every write that can lower access in that owner's vaults, and a DocDO re-resolves sockets admitted under an older one.
 */
export const accessEpochs = sqliteTable('access_epochs', {
  ownerUserId: text('owner_user_id').primaryKey(),
  epoch: integer('epoch').notNull().default(0),
});

/**
 * Sign-up counts per client address (an IPv6 /64 as one; A§7), one fixed window per key. Separate from better-auth's
 * `rate_limit`, which prunes every row older than its longest window, a minute. Closed windows are pruned in bounded
 * batches through the window index.
 */
export const signupLimits = sqliteTable(
  'signup_limits',
  {
    key: text('key').primaryKey(),
    windowStart: integer('window_start').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [index('signup_limits_window_idx').on(t.windowStart)],
);

/** The models better-auth's drizzle adapter reads, keyed by its model names. */
export const authSchema = { user, session, account, verification, deviceCode, rateLimit };
