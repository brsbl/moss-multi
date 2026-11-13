// Share, v2 (T1.1, T2.4, T3.6): one dialog for a note, a folder or a vault. An owner adds a person by email at view,
// comment, edit or owner access, or one of their own agents by the id copied from Settings → Agents (at most edit;
// PRODUCT ruling 20), sees who has access (and emails waiting on an invite), and creates, copies and
// revokes links. Moss has no sharing, so the layout follows glyphdown's ShareDialog
// (docs/design/glyphdown-reference.md), built from moss's own parts: Settings' ModalShell, section labels and cards,
// its segmented choice for access levels, and the DS Input and Button. The note's top bar (ShareControl), a folder's
// context menu (FolderMenuItems) and the vault switcher open it through `openShare`. Each person's (and invite's)
// access has glyphdown's role select and Remove button; lowering or removing someone closes their open windows through
// the one kick path (T2.5). An owner also sees, read-only, who reaches the target from the folders and vault above it
// and which of those places have links, each with a Manage button to that place's own dialog (T9.7).
import { ModalShell } from '@moss-desktop/renderer/components/ModalShell';
import { Button } from '@moss/shared/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@moss/shared/components/ui/dropdown-menu';
import { Input } from '@moss/shared/components/ui/input';
import { LINK_ROLES, SHARE_ROLES, type LinkRole, type Role, type ShareRole } from '@moss-multi/protocol/roles';
import { Check, ChevronDown, UserPlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { useDocRole } from '../access.ts';
import { useTerminal } from '../collab/terminal.ts';
import { heldRead, isLeaveCancelled, leaveAwareSend } from '../leave.ts';

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

/** A folder or vault above the target; the server names only the places the caller manages. */
interface Place {
  id: string;
  name: string;
  kind: 'folder' | 'vault';
}

interface Member {
  principalId: string;
  principalType: 'user' | 'agent';
  name: string;
  email?: string;
  role: Role;
  /** A higher role this member also has from a place above; `place` null for one the caller does not manage. */
  also?: { role: Role; place: Place | null };
}

/** People who reach the target through a place above it (null: places the caller does not manage). */
interface InheritedGroup {
  place: Place | null;
  members: Member[];
}

/** A place above with a live link, at its highest link role. */
interface LinkAbove {
  place: Place;
  role: LinkRole;
}

interface PendingInvite {
  email: string;
  role: Role;
  /** The copyable /invite link (T2.8); invites are copy-link only, and no email is sent. */
  url?: string;
}

interface ShareLink {
  token: string;
  role: LinkRole;
  createdAt: number;
}

type Where = 'people' | 'members' | 'links';
type Status = { tone: 'error' | 'done'; text: string; where: Where } | null;

const SECTION_LABEL = 'text-micro font-medium uppercase tracking-wider text-ink-faint';
const CARD = 'rounded-lg border border-border-subtle bg-surface-raised-card p-3';

/** Moss's checked menu keeps all five access roles in one compact, keyboard-reachable choice. */
function AccessChoice<R extends Role>({ label, roles, value, onChange, disabled }: {
  label: string; roles: readonly R[]; value: R; onChange: (role: R) => void; disabled: boolean;
}): ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" disabled={disabled} aria-label={label}
        className="flex h-7 items-center gap-2 rounded px-2 text-xs text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
        {ACCESS_LABEL[value]}<ChevronDown aria-hidden className="h-3 w-3" strokeWidth={1.5} />
      </button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-36">
        {roles.map(role => <DropdownMenuItem key={role} onSelect={() => onChange(role)} className="gap-2 text-xs">
          <span className="flex-1">{ACCESS_LABEL[role]}</span>{role === value && <Check aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />}
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusLine({ status, where }: { status: Status; where: Where }): ReactNode {
  if (!status || status.where !== where) return null;
  return (
    <p role={status.tone === 'error' ? 'alert' : 'status'} className={status.tone === 'error' ? 'text-xs text-accent-terracotta' : 'text-xs text-ink-muted'}>
      {status.text}
    </p>
  );
}

/**
 * One person's or invite's access, as glyphdown's ShareDialog offers it: a select of the share roles and a Remove
 * button. A native select, because moss's dropdown menu renders beneath a modal (its positioner is z-50, the dialog 130).
 */
function AccessControls({ who, role, roles = SHARE_ROLES, disabled, onChoose }: {
  who: string; role: Role; roles?: readonly ShareRole[]; disabled: boolean; onChoose: (choice: ShareRole | 'remove') => void;
}): ReactNode {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <select
        aria-label={`Access for ${who}`}
        value={role}
        disabled={disabled}
        onChange={(event) => onChoose(event.target.value as ShareRole)}
        className="h-7 rounded-md border border-border-default bg-surface-raised-card px-1.5 text-xs text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:opacity-60"
      >
        {(roles as readonly Role[]).includes(role) ? null : <option value={role}>{ACCESS_LABEL[role]}</option>}
        {roles.map((choice) => <option key={choice} value={choice}>{ACCESS_LABEL[choice]}</option>)}
      </select>
      <button
        type="button"
        aria-label={`Remove ${who}`}
        title="Remove access"
        disabled={disabled}
        onClick={() => onChoose('remove')}
        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-raised-control hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:opacity-60"
      >
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** An agent acts at most as an editor (A§8), so its row offers no owner. */
const AGENT_ROLES = SHARE_ROLES.filter((role) => role !== 'owner');

const apiBase = (target: ShareTarget) => `/api/${target.type === 'doc' ? 'docs' : 'folders'}/${encodeURIComponent(target.id)}`;

/** The URL a link opens: the note itself, or the folder landing (A§4.2). */
const linkUrl = (target: ShareTarget, token: string) =>
  new URL(`/${target.type === 'doc' ? 'd' : 'f'}/${encodeURIComponent(target.id)}?share=${token}`, window.location.origin).href;

/** A read is held while the page leaves and sent again if it stays; a change is sent at most once, and one a leave cut
 * off rejects with `LeaveCancelled` once the page stays, for the caller to read the lists again (leave.ts). */
export async function call<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: (T & { message?: string }) | null }> {
  const send = (signal: AbortSignal | undefined) => fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    ...(signal ? { signal } : {}),
  });
  // The body is read whole first, so a leave that cuts it off is seen, never taken for a body that is not JSON.
  const read = async (response: Response) => {
    const text = await response.text();
    let body: (T & { message?: string }) | null = null;
    try { body = JSON.parse(text) as T & { message?: string }; } catch { /* not JSON */ }
    return { ok: response.ok, status: response.status, body };
  };
  return (init.method ?? 'GET').toUpperCase() === 'GET' ? heldRead(send, read) : leaveAwareSend(send, read);
}

/** A failed request is the unreachable sentence, unless a leave cut it off (handled: the lists are read again). */
const unreachable = (error: unknown): never => {
  throw isLeaveCancelled(error) ? error : new Error(UNREACHABLE);
};

function copy(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

/** The shell keeps a fixed title (Moss prints titles in faint capitals); the body's first line names the target. */
function titles(target: ShareTarget, name: string | null): { title: string; description: string; lead: string; named: string | null; rest: string } {
  if (target.type === 'doc') {
    const rest = 'with people by email, with one of your agents by its ID, or with anyone who has a link.';
    return { title: 'Share', description: name ? `Share “${name}” ${rest}` : `Share this note ${rest}`, lead: name ? 'Share' : 'Share this note', named: name || null, rest };
  }
  const rest = 'with people by email, or with anyone who has a link.';
  return { title: target.vault ? 'Share vault' : 'Share folder', description: `Share every note in “${target.name}” ${rest}`, lead: 'Share every note in', named: target.name, rest };
}

const thisTarget = (target: ShareTarget) => (target.type === 'doc' ? 'this note' : target.vault ? 'this vault' : 'this folder');
const placeName = (place: Place) => `${place.kind === 'vault' ? 'vault' : 'folder'} “${place.name}”`;
/** A place by kind and name, or, for one the caller does not manage, only that it is above. */
const placeRef = (place: Place | null, target: ShareTarget) => (place ? placeName(place) : `a folder above ${thisTarget(target)}`);
const LINK_ALLOWS: Record<LinkRole, string> = { viewer: 'can view', commenter: 'can comment on', editor: 'can edit' };

/** Opens the place's own Share dialog in this one's stead. */
const manage = (place: Place) => openShare({ type: 'folder', id: place.id, name: place.name, vault: place.kind === 'vault' });

/** The quiet ghost Button Moss's Properties uses for "Add field", here on a place's line. */
function ManageButton({ place, disabled }: { place: Place; disabled: boolean }): ReactNode {
  return (
    <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={`Manage ${placeName(place)}`} onClick={() => manage(place)}
      className="-mr-1.5 h-6 shrink-0 px-1.5 text-micro font-normal text-ink-faint hover:bg-surface-transparent hover:text-ink-muted">
      Manage
    </Button>
  );
}

/** A person's or agent's name, its agent tag and (for the owner's view) email, then any extra faint line. */
function Identity({ member, children }: { member: Member; children?: ReactNode }): ReactNode {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-ink-default">
        {member.name}
        {member.principalType === 'agent' ? <span className="ml-1.5 text-xs text-ink-faint">agent</span> : null}
      </p>
      {member.email ? <p className="truncate font-mono text-xs text-ink-muted">{member.email}</p> : null}
      {children}
    </div>
  );
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
  const [name, setName] = useState<string | null>(null);
  const [inherited, setInherited] = useState<InheritedGroup[]>([]);
  const [linksAbove, setLinksAbove] = useState<LinkAbove[]>([]);
  const base = apiBase(target);
  const { title, description, lead, named, rest } = titles(target, name);

  // Reads overlap when shares follow each other quickly; only the newest may paint, or an older read would drop a row.
  const reads = useRef(0);
  const load = useCallback(async () => {
    const read = ++reads.current;
    try {
      const [people, live, pendingLinks] = await Promise.all([
        call<{ name?: string; members: Member[]; invites?: PendingInvite[]; inherited?: InheritedGroup[] }>(`${base}/members`),
        call<{ links: ShareLink[]; inherited?: LinkAbove[] }>(`${base}/links`),
        call<{ invites: PendingInvite[] }>(`${base}/invites`),
      ]);
      if (read !== reads.current) return;
      if (!people.ok || !people.body || !live.ok || !live.body || !pendingLinks.ok || !pendingLinks.body) throw new Error(String(people.status));
      setMembers(people.body.members);
      setName(people.body.name ?? null);
      setInherited(people.body.inherited ?? []);
      setInvites(pendingLinks.body.invites);
      setLinks(live.body.links);
      setLinksAbove(live.body.inherited ?? []);
      setLoadError(null);
    } catch {
      if (read === reads.current) setLoadError('Couldn’t load who has access. Close and open Share to try again.');
    }
  }, [base]);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    void load();
  }, [open, load]);

  /** One request at a time; a failure says why, in the section that asked. A change is confirmed as soon as the
   * server takes it, and then the lists are read again. */
  async function run(where: Where, work: () => Promise<string | null>, reload = true): Promise<void> {
    if (pending) return;
    setPending(true);
    setStatus(null);
    let took = false;
    try {
      const done = await work();
      took = true;
      if (done) setStatus({ tone: 'done', text: done, where });
    } catch (error) {
      // A change the page's leave cut off may have landed: the lists say whether it did.
      if (isLeaveCancelled(error)) took = true;
      else setStatus({ tone: 'error', text: error instanceof Error && error.message ? error.message : UNREACHABLE, where });
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
      setStatus({ tone: 'error', text: 'Enter an email address or an agent ID.', where: 'people' });
      return;
    }
    // An email has an @; anything else is the id of one of the caller's agents, copied from Settings → Agents.
    if (!address.includes('@')) {
      if (access === 'owner') {
        setStatus({ tone: 'error', text: 'An agent can have at most edit access.', where: 'people' });
        return;
      }
      void run('people', async () => {
        const answer = await call<{ shared?: { name: string } }>(`${base}/members`, { method: 'POST', body: JSON.stringify({ agentId: address, role: access }) })
          .catch(unreachable);
        if (!answer.ok || !answer.body?.shared) throw refused(answer.body, 'Sharing didn’t work. Try again.');
        setEmail('');
        return `Shared with ${answer.body.shared.name}.`;
      });
      return;
    }
    void run('people', async () => {
      const answer = await call<{ shared?: { email: string } }>(`${base}/members`, { method: 'POST', body: JSON.stringify({ email: address, role: access }) })
        .catch(unreachable);
      if (!answer.ok || !answer.body?.shared) throw refused(answer.body, 'Sharing didn’t work. Try again.');
      setEmail('');
      return `Shared with ${answer.body.shared.email}.`;
    });
  }

  /** Changes or removes a member (by id) or an invite (by email); the server closes their windows on a lowering. */
  function changeAccess(who: { principalId: string } | { email: string }, label: string, choice: ShareRole | 'remove'): void {
    void run('members', async () => {
      const answer = await call(`${base}/members`, {
        method: choice === 'remove' ? 'DELETE' : 'PATCH',
        body: JSON.stringify(choice === 'remove' ? who : { ...who, role: choice }),
      }).catch(unreachable);
      if (!answer.ok) throw refused(answer.body, 'That change didn’t save. Try again.');
      return choice === 'remove' ? `Removed ${label}.` : `${label} now has “${ACCESS_LABEL[choice]}” access.`;
    });
  }

  function createLink(): void {
    void run('links', async () => {
      const answer = await call<{ link?: ShareLink }>(`${base}/links`, { method: 'POST', body: JSON.stringify({ role: linkAccess }) })
        .catch(unreachable);
      if (!answer.ok || !answer.body?.link) throw refused(answer.body, 'The link wasn’t created. Try again.');
      return 'Link created. Anyone who has it can open this.';
    });
  }

  function revoke(link: ShareLink): void {
    void run('links', async () => {
      const answer = await call(`${base}/links/${link.token}`, { method: 'DELETE' }).catch(unreachable);
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

  function copyInvite(invite: PendingInvite): void {
    void run('people', async () => {
      try {
        await copy(invite.url ?? '');
      } catch {
        throw new Error('Couldn’t copy. Select the invite link and copy it instead.');
      }
      return `Copied the invite link for ${invite.email}. It works only when they sign in with that email.`;
    }, false);
  }

  return (
    <ModalShell open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <p className="text-xs text-ink-muted">
        {lead}
        {named ? <>{' '}<span className="inline-block max-w-full truncate align-bottom text-ink-default">“{named}”</span></> : null}
        {' '}{rest}
      </p>
      <div className="space-y-2">
        <span className={SECTION_LABEL}>Invite people</span>
        <form aria-label="Share with a person" onSubmit={share} className={`${CARD} space-y-3`}>
          <Input
            type="text"
            aria-label="Email or agent ID"
            placeholder="name@example.com or your agent’s ID"
            autoComplete="off"
            value={email}
            readOnly={pending}
            onChange={(event) => setEmail(event.target.value)}
            className="border-border-default"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AccessChoice label="Access" roles={SHARE_ROLES} value={access} onChange={setAccess} disabled={pending} />
            <Button type="submit" size="sm" variant="secondary" disabled={pending}>
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
              {members.map((member, index) => (
                <li key={member.principalId} className="flex items-center justify-between gap-3">
                  <Identity member={member}>
                    {member.also ? (
                      <p className="text-micro text-ink-faint">Also “{ACCESS_LABEL[member.also.role]}” from {placeRef(member.also.place, target)}</p>
                    ) : null}
                  </Identity>
                  {/* The API lists the vault's owner first; they hold no grant, so their access cannot change. */}
                  {index === 0 ? (
                    <span className="shrink-0 px-2 text-xs text-ink-faint">{ACCESS_LABEL[member.role]}</span>
                  ) : (
                    <AccessControls who={member.name} role={member.role} disabled={pending}
                      roles={member.principalType === 'agent' ? AGENT_ROLES : SHARE_ROLES}
                      onChoose={(choice) => changeAccess({ principalId: member.principalId }, member.name, choice)} />
                  )}
                </li>
              ))}
              {invites.map((invite) => (
                <li key={`invite:${invite.email}`} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-ink-muted">{invite.email}</p>
                      <p className="text-micro text-ink-faint">Invited</p>
                    </div>
                    <AccessControls who={invite.email} role={invite.role} disabled={pending}
                      onChoose={(choice) => changeAccess({ email: invite.email }, invite.email, choice)} />
                  </div>
                  {invite.url ? (
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        aria-label={`Invite link for ${invite.email}`}
                        value={invite.url}
                        onFocus={(event) => event.currentTarget.select()}
                        className="h-7 min-w-0 flex-1 border-border-default font-mono text-xs"
                      />
                      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => copyInvite(invite)}>
                        Copy
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {invites.length > 0 ? (
            <p className="mt-3 text-xs text-ink-muted">
              An invite link works only for someone signed in with the email it names. Copy it and send it to them.
            </p>
          ) : null}
          {/* Who reaches it from above, read-only; their access changes in that place's own dialog. */}
          {!loadError && members !== null ? inherited.map((group) => {
            const heading = `From ${placeRef(group.place, target)}`;
            return (
              <div key={group.place?.id ?? 'above'} className="mt-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-micro text-ink-faint">{heading}</p>
                  {group.place ? <ManageButton place={group.place} disabled={pending} /> : null}
                </div>
                <ul aria-label={heading} className="space-y-2">
                  {group.members.map((member) => (
                    <li key={member.principalId} className="flex items-center justify-between gap-3">
                      <Identity member={member} />
                      <span className="shrink-0 px-2 text-xs text-ink-faint">{ACCESS_LABEL[member.role]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          }) : null}
        </div>
        <StatusLine status={status} where="members" />
      </div>
      <div className="space-y-2">
        <span className={SECTION_LABEL}>Share links</span>
        <div className={`${CARD} space-y-3`}>
          {linksAbove.map(({ place, role }) => (
            <div key={place.id} className="flex items-center justify-between gap-3">
              <p className="min-w-0 text-xs text-ink-muted">Anyone with the link to {placeName(place)} {LINK_ALLOWS[role]} {thisTarget(target)}.</p>
              <ManageButton place={place} disabled={pending} />
            </div>
          ))}
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
  // A window whose session ended (or whose note went away) can no longer share it.
  const terminal = useTerminal(docId);
  if (role !== 'owner' || (terminal !== null && terminal !== 'conn-limit')) return null;
  return (
    <button
      type="button"
      data-collab-chrome="" data-close-collaboration=""
      aria-haspopup="dialog"
      aria-label="Share"
      onClick={() => openShare({ type: 'doc', id: docId })}
      className="flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded px-2 text-xs text-ink-muted transition-colors hover:bg-surface-note-hover/40 hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
    >
      <UserPlus aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
      <span>Share note…</span>
    </button>
  );
}
