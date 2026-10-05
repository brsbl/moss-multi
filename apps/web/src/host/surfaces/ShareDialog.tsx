// Share, v2 (T1.1, T2.4): one dialog for a note, a folder or a vault. An owner adds a person by email at view,
// comment, edit or owner access, sees who has access (and emails waiting on an invite), and creates, copies and
// revokes links. Moss has no sharing, so the layout follows glyphdown's ShareDialog
// (docs/design/glyphdown-reference.md), built from moss's own parts: Settings' ModalShell, section labels and cards,
// its segmented choice for access levels, and the DS Input and Button. The note's top bar (ShareControl), a folder's
// context menu (FolderMenuItems) and the vault switcher open it through `openShare`. Changing or removing a person's
// access comes with the one kick path (T2.5).
import { ModalShell } from '@moss-desktop/renderer/components/ModalShell';
import { Button } from '@moss/shared/components/ui/button';
import { Input } from '@moss/shared/components/ui/input';
import { LINK_ROLES, SHARE_ROLES, type LinkRole, type Role, type ShareRole } from '@moss-multi/protocol/roles';
import { UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { useDocRole } from '../access.ts';

export type ShareTarget =
  | { type: 'doc'; id: string }
  | { type: 'folder'; id: string; name: string; vault: boolean };

const ACCESS_LABEL: Record<Role, string> = {
  viewer: 'Can view',
  commenter: 'Can comment',
  suggester: 'Can suggest',
  editor: 'Can edit',
  owner: 'Owner',
};

const UNREACHABLE = 'Couldn’t reach the server. Check your connection and try again.';

interface Member {
  principalId: string;
  principalType: 'user' | 'agent';
  name: string;
  email?: string;
  role: Role;
}

interface PendingInvite {
  email: string;
  role: Role;
}

interface ShareLink {
  token: string;
  role: LinkRole;
  createdAt: number;
}

type Status = { tone: 'error' | 'done'; text: string; where: 'people' | 'links' } | null;

const SECTION_LABEL = 'text-micro font-medium uppercase tracking-wider text-ink-faint';
const CARD = 'rounded-lg border border-border-subtle bg-surface-raised-card p-3';

/** Settings' segmented choice (AppearanceSection), here for the access a share or a link grants. */
function AccessChoice<R extends Role>({ label, roles, value, onChange, disabled }: {
  label: string; roles: readonly R[]; value: R; onChange: (role: R) => void; disabled: boolean;
}): ReactNode {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap items-center gap-0.5 rounded-lg bg-surface-raised-control p-0.5">
      {roles.map((role) => {
        const selected = role === value;
        return (
          <button
            key={role}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(role)}
            className={
              selected
                ? 'inline-flex h-6 items-center rounded-md bg-surface-raised-card px-3 text-xs font-medium leading-none text-ink-default shadow-sm ring-1 ring-border-strong/40 transition-colors focus-visible:outline-none focus-visible:ring-ink-default/15'
                : 'inline-flex h-6 items-center rounded-md px-3 text-xs font-medium leading-none text-ink-faint transition-colors hover:bg-surface-raised-control/50 hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15'
            }
          >
            {ACCESS_LABEL[role]}
          </button>
        );
      })}
    </div>
  );
}

function StatusLine({ status, where }: { status: Status; where: 'people' | 'links' }): ReactNode {
  if (!status || status.where !== where) return null;
  return (
    <p role={status.tone === 'error' ? 'alert' : 'status'} className={status.tone === 'error' ? 'text-xs text-accent-terracotta' : 'text-xs text-ink-muted'}>
      {status.text}
    </p>
  );
}

const apiBase = (target: ShareTarget) => `/api/${target.type === 'doc' ? 'docs' : 'folders'}/${encodeURIComponent(target.id)}`;

/** The URL a link opens: the note itself, or the folder landing (A§4.2). */
const linkUrl = (target: ShareTarget, token: string) =>
  new URL(`/${target.type === 'doc' ? 'd' : 'f'}/${encodeURIComponent(target.id)}?share=${token}`, window.location.origin).href;

async function call<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: (T & { message?: string }) | null }> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  return { ok: response.ok, status: response.status, body: (await response.json().catch(() => null)) as (T & { message?: string }) | null };
}

function copy(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

function titles(target: ShareTarget): { title: string; description: string } {
  if (target.type === 'doc') return { title: 'Share', description: 'Share this note with people by email, or with anyone who has a link.' };
  if (target.vault) return { title: 'Share vault', description: `Share every note in “${target.name}” with people by email, or with anyone who has a link.` };
  return { title: 'Share folder', description: `Share every note in “${target.name}” with people by email, or with anyone who has a link.` };
}

function ShareDialog({ target, open, onOpenChange }: { target: ShareTarget; open: boolean; onOpenChange: (open: boolean) => void }): ReactNode {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [access, setAccess] = useState<ShareRole>('editor');
  const [linkAccess, setLinkAccess] = useState<LinkRole>('viewer');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const base = apiBase(target);
  const { title, description } = titles(target);

  const load = useCallback(async () => {
    try {
      const [people, live] = await Promise.all([
        call<{ members: Member[]; invites?: PendingInvite[] }>(`${base}/members`),
        call<{ links: ShareLink[] }>(`${base}/links`),
      ]);
      if (!people.ok || !people.body || !live.ok || !live.body) throw new Error(String(people.status));
      setMembers(people.body.members);
      setInvites(people.body.invites ?? []);
      setLinks(live.body.links);
      setLoadError(null);
    } catch {
      setLoadError('Couldn’t load who has access. Close and open Share to try again.');
    }
  }, [base]);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    void load();
  }, [open, load]);

  /** One request at a time; a failure says why, in the section that asked. A change is confirmed as soon as the
   * server takes it, and then the lists are read again. */
  async function run(where: 'people' | 'links', work: () => Promise<string | null>, reload = true): Promise<void> {
    if (pending) return;
    setPending(true);
    setStatus(null);
    let took = false;
    try {
      const done = await work();
      took = true;
      if (done) setStatus({ tone: 'done', text: done, where });
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error && error.message ? error.message : UNREACHABLE, where });
    } finally {
      setPending(false);
    }
    // The form frees with the confirmation; the lists catch up behind it.
    if (took && reload) await load();
  }

  const refused = (body: { message?: string } | null, fallback: string) => new Error(body?.message ?? fallback);

  function share(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const address = email.trim();
    if (!address) {
      setStatus({ tone: 'error', text: 'Enter an email address.', where: 'people' });
      return;
    }
    void run('people', async () => {
      const answer = await call<{ shared?: { email: string } }>(`${base}/members`, { method: 'POST', body: JSON.stringify({ email: address, role: access }) })
        .catch(() => { throw new Error(UNREACHABLE); });
      if (!answer.ok || !answer.body?.shared) throw refused(answer.body, 'Sharing didn’t work. Try again.');
      setEmail('');
      return `Shared with ${answer.body.shared.email}.`;
    });
  }

  function createLink(): void {
    void run('links', async () => {
      const answer = await call<{ link?: ShareLink }>(`${base}/links`, { method: 'POST', body: JSON.stringify({ role: linkAccess }) })
        .catch(() => { throw new Error(UNREACHABLE); });
      if (!answer.ok || !answer.body?.link) throw refused(answer.body, 'The link wasn’t created. Try again.');
      return 'Link created. Anyone who has it can open this.';
    });
  }

  function revoke(link: ShareLink): void {
    void run('links', async () => {
      const answer = await call(`${base}/links/${link.token}`, { method: 'DELETE' }).catch(() => { throw new Error(UNREACHABLE); });
      if (!answer.ok) throw refused(answer.body, 'The link wasn’t revoked. Try again.');
      return 'Link revoked. It no longer opens anything.';
    });
  }

  function copyLink(link: ShareLink): void {
    void run('links', async () => {
      try {
        await copy(linkUrl(target, link.token));
      } catch {
        throw new Error('Couldn’t copy. Select the link and copy it instead.');
      }
      return 'Copied the link.';
    }, false);
  }

  return (
    <ModalShell open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="space-y-2">
        <span className={SECTION_LABEL}>Invite people</span>
        <form aria-label="Share with a person" onSubmit={share} className={`${CARD} space-y-3`}>
          <Input
            type="email"
            aria-label="Email"
            placeholder="name@example.com"
            autoComplete="off"
            value={email}
            readOnly={pending}
            onChange={(event) => setEmail(event.target.value)}
            className="border-border-default"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AccessChoice label="Access" roles={SHARE_ROLES} value={access} onChange={setAccess} disabled={pending} />
            <Button type="submit" size="sm" disabled={pending}>
              Share
            </Button>
          </div>
          <StatusLine status={status} where="people" />
        </form>
      </div>
      <div className="space-y-2">
        <span className={SECTION_LABEL}>People with access</span>
        <div className={CARD}>
          {loadError ? (
            <p role="alert" className="text-xs text-accent-terracotta">
              {loadError}
            </p>
          ) : members === null ? (
            <p className="text-xs text-ink-faint">Loading…</p>
          ) : (
            <ul aria-label="People with access" className="space-y-2">
              {members.map((member) => (
                <li key={member.principalId} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink-default">{member.name}</p>
                    {member.email ? <p className="truncate font-mono text-xs text-ink-muted">{member.email}</p> : null}
                  </div>
                  <span className="shrink-0 text-xs text-ink-faint">{ACCESS_LABEL[member.role]}</span>
                </li>
              ))}
              {invites.map((invite) => (
                <li key={`invite:${invite.email}`} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-ink-muted">{invite.email}</p>
                    <p className="text-micro text-ink-faint">Invited</p>
                  </div>
                  <span className="shrink-0 text-xs text-ink-faint">{ACCESS_LABEL[invite.role]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="space-y-2">
        <span className={SECTION_LABEL}>Share links</span>
        <div className={`${CARD} space-y-3`}>
          <p className="text-xs text-ink-muted">Anyone with a link can open this. Without signing in they can only view it.</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AccessChoice label="Link access" roles={LINK_ROLES} value={linkAccess} onChange={setLinkAccess} disabled={pending} />
            <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={createLink}>
              Create link
            </Button>
          </div>
          {links && links.length > 0 ? (
            <ul aria-label="Share links" className="space-y-2">
              {links.map((link) => (
                <li key={link.token} className="flex flex-wrap items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-ink-faint">{ACCESS_LABEL[link.role]}</span>
                  <Input
                    readOnly
                    aria-label={`${ACCESS_LABEL[link.role]} link`}
                    value={linkUrl(target, link.token)}
                    onFocus={(event) => event.currentTarget.select()}
                    className="h-7 min-w-0 flex-1 basis-40 border-border-default font-mono text-xs"
                  />
                  <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => copyLink(link)}>
                    Copy
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => revoke(link)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <StatusLine status={status} where="links" />
        </div>
      </div>
    </ModalShell>
  );
}

// The one open dialog, so a context-menu item can open it after its menu unmounts.
let current: ShareTarget | null = null;
const listeners = new Set<() => void>();
const publish = (next: ShareTarget | null) => {
  current = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function openShare(target: ShareTarget): void {
  publish(target);
}

/** Rendered once beside moss's App (boot.tsx). */
export function ShareDialogHost(): ReactNode {
  const target = useSyncExternalStore(subscribe, () => current, () => null);
  const [shown, setShown] = useState<ShareTarget | null>(null);
  useEffect(() => {
    if (target) setShown(target);
  }, [target]);
  if (!shown) return null;
  return <ShareDialog key={`${shown.type}:${shown.id}`} target={shown} open={target !== null} onOpenChange={(open) => { if (!open) publish(null); }} />;
}

/** The top bar's Share button; only an owner shares (A§8), so nobody else is offered it. */
export function ShareControl({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  if (role !== 'owner') return null;
  return (
    <button
      type="button"
      data-collab-chrome=""
      aria-haspopup="dialog"
      aria-label="Share"
      onClick={() => openShare({ type: 'doc', id: docId })}
      className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs font-medium text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
    >
      <UserPlus aria-hidden className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Share</span>
    </button>
  );
}
