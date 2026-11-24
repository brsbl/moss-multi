// Share, v2 (T1.1, T2.4, T3.6): one dialog for a note, a folder or a vault. An owner adds a person by email at view,
// comment, edit or owner access, or one of their own agents by the id copied from Settings → Agents (at most edit;
// PRODUCT ruling 20), sees who has access (and emails waiting on an invite), and creates, copies and
// revokes links. Moss has no sharing, so it is built from Settings' own parts (T9.36): ModalShell's frame, micro section
// labels over flat rows, its 24 px text actions, the DS Input, and the application menu's 28 px checked rows for every
// role chooser (the invite's, each person's and invite's, a new link's), whose last item is Remove access. The first
// line names the note, folder or vault. The note's More actions (useCanShare), a folder's context menu
// (FolderMenuItems) and Settings' Vaults open it through `openShare`. Lowering or removing someone closes their open
// windows through the one kick path (T2.5). An owner also sees, read-only, who reaches the target from the folders and
// vault above it, one heading per place, and which of those places have links, each with a Manage action to that
// place's own dialog (T9.7). Sharing by email makes an invite link and says nothing is emailed; an agent's id adds the
// agent; each Copy confirms on itself (T9.8).
import { DialogDimOverlay } from '@moss-desktop/renderer/components/DialogDimOverlay';
import { useNotePaneDialogPosition } from '@moss/shared/components/ui/use-note-pane-dialog-position';
import { Dialog } from '@moss/shared/primitives';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@moss/shared/components/ui/dropdown-menu';
import { Input } from '@moss/shared/components/ui/input';
import { noteEntityAtom } from '@moss/shared/state/note-atoms';
import { LINK_ROLES, SHARE_ROLES, type LinkRole, type Role, type ShareRole } from '@moss-multi/protocol/roles';
import { useStore } from 'jotai';
import { Check, ChevronDown, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useDocRole } from '../access.ts';
import { sessionFetch, useSessionEnded } from '../session-fetch.ts';
import { useTerminal } from '../collab/terminal.ts';
import { UNTITLED } from '../collab/title-binding.ts';
import { heldRead, isLeaveCancelled, leaveAwareSend } from '../leave.ts';

export type ShareTarget =
  | { type: 'doc'; id: string }
  | { type: 'folder'; id: string; name: string; vault: boolean };

export const ACCESS_LABEL: Record<Role, string> = {
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

type Where = 'people' | 'members' | 'invites' | 'links';
/** `invite`: the email whose invite link the status offers to copy (T9.8). */
type Status = { tone: 'error' | 'done'; text: string; where: Where; invite?: string } | null;

/** An agent's id is a UUID, copied from Settings → Agents; anything else without an @ is not sent (T9.8). */
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SECTION_LABEL = 'text-micro font-medium uppercase tracking-wider text-ink-faint';
/** Settings' text action (Connected Folders' Add): 24 px, 12 px, neutral ink; it fills only on hover. */
const ACTION = 'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-muted transition-colors hover:bg-border-subtle hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-not-allowed disabled:opacity-60';
/** A read-only address or the invite field: the DS Input at the actions' scale. */
const FIELD = 'h-7 min-w-0 border-border-default px-2 py-1 text-xs';
/** The application menu's row recipe (More actions, Switch vault…). */
const MENU_ROW = 'gap-2 text-xs';
/** The faint read-only role of the vault's owner and of everyone reaching the target from above. */
const ROLE_TEXT = 'shrink-0 px-2 text-xs text-ink-faint';

/**
 * A role chooser: a quiet trigger reading the role, opening Moss's checked menu of the roles `roles` allows (the
 * current one checked, typeahead by name) and, for someone already listed, Remove access after a separator, in the
 * terracotta Moss gives Move to Trash. The menu floats above the dialog (styles.css, data-dialog-menu).
 */
function RoleMenu<R extends Role>({ label, roles, value, onChange, onRemove, disabled }: {
  label: string; roles: readonly R[]; value: Role; onChange: (role: R) => void; onRemove?: () => void; disabled: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  // Enter and Space choose the highlighted role: the vendored radio item takes only a pointer click inside a dialog, and
  // WebKit leaves focus on the trigger after a click, so both the menu and its trigger listen.
  const chooseByKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!open || (event.key !== 'Enter' && event.key !== ' ')) return;
    const row = document.querySelector<HTMLElement>('[data-dialog-menu] [role="menuitemradio"][data-highlighted]');
    const role = roles.find((choice) => choice === row?.dataset.role);
    if (!role) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    if (role !== value) onChange(role);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={label} disabled={disabled} className={`${ACTION} font-normal`} onKeyDownCapture={chooseByKey}>
          <span>{ACCESS_LABEL[value]}</span>
          <ChevronDown aria-hidden className="h-3 w-3 text-ink-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-dialog-menu="" align="end" sideOffset={4} collisionPadding={16} className="min-w-0 w-max max-w-[calc(100vw-2rem)]" onKeyDownCapture={chooseByKey}>
        <DropdownMenuRadioGroup value={value} onValueChange={(role) => { if (role !== value) onChange(role as R); }}>
          {roles.map((role) => (
            <DropdownMenuRadioItem key={role} value={role} data-role={role} closeOnClick className={MENU_ROW}>
              <span className="flex w-3.5 shrink-0 justify-center">{role === value ? <Check aria-hidden className="h-3.5 w-3.5" /> : null}</span>
              <span className="flex-1">{ACCESS_LABEL[role]}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {onRemove ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRemove} className={`${MENU_ROW} text-accent-terracotta focus:text-accent-terracotta`}>
              <span className="w-3.5 shrink-0" />
              <span className="flex-1">Remove access</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusLine({ status, where, action }: { status: Status; where: Where; action?: ReactNode }): ReactNode {
  if (!status || status.where !== where) return null;
  const line = (
    <p role={status.tone === 'error' ? 'alert' : 'status'} className={status.tone === 'error' ? 'text-xs text-accent-terracotta' : 'text-xs text-ink-muted'}>
      {status.text}
    </p>
  );
  if (!action) return line;
  return (
    <div className="flex items-center justify-between gap-3">
      {line}
      {action}
    </div>
  );
}

/** A copy that confirms on the button itself with a check for 2 s, as Moss's Share with Agent does
 * (CopyForAgentDialog); a refused clipboard says so through `onFail`. */
function CopyButton({ text, label = 'Copy', onFail, className }: {
  text: string | undefined; label?: string; onFail: () => void; className?: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const press = () => {
    if (!text) return;
    void copy(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    }, onFail);
  };
  return (
    <button type="button" disabled={!text} onClick={press} className={`${ACTION} ${className ?? ''}`}>
      {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : null}
      {copied ? 'Copied' : label}
    </button>
  );
}

/** One person's or invite's access: their role menu, with Remove access. */
function AccessControls({ who, role, roles = SHARE_ROLES, disabled, onChoose }: {
  who: string; role: Role; roles?: readonly ShareRole[]; disabled: boolean; onChoose: (choice: ShareRole | 'remove') => void;
}): ReactNode {
  return <RoleMenu label={`Access for ${who}`} roles={roles} value={role} disabled={disabled} onChange={onChoose} onRemove={() => onChoose('remove')} />;
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
  const send = (signal: AbortSignal | undefined) => sessionFetch(path, {
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

/** Async, so a page without a clipboard rejects rather than throws. */
async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** The trimmed title of moss's note record; null for none, an empty one, or moss's placeholder for an empty title. */
function shownTitle(note: object | null): string | null {
  const title = (note as { title?: unknown } | null)?.title;
  const trimmed = typeof title === 'string' ? title.trim() : '';
  return trimmed && trimmed !== UNTITLED ? trimmed : null;
}

/** The shell keeps a fixed title (Moss prints titles in faint capitals); the body's first line names the target. */
function titles(target: ShareTarget, name: string | null): { title: string; description: string; kind: string; named: string | null } {
  if (target.type === 'doc') {
    const rest = 'with people by email, with one of your agents by its ID, or with anyone who has a link.';
    return { title: 'Share', description: name ? `Share “${name}” ${rest}` : `Share this note ${rest}`, kind: 'Note', named: name || null };
  }
  const rest = 'with people by email, or with anyone who has a link.';
  return {
    title: target.vault ? 'Share vault' : 'Share folder', description: `Share every note in “${target.name}” ${rest}`,
    kind: target.vault ? 'Vault' : 'Folder', named: target.name,
  };
}

const thisTarget = (target: ShareTarget) => (target.type === 'doc' ? 'this note' : target.vault ? 'this vault' : 'this folder');
const placeName = (place: Place) => `${place.kind === 'vault' ? 'vault' : 'folder'} “${place.name}”`;
/** A place by kind and name, or, for one the caller does not manage, only that it is above. */
const placeRef = (place: Place | null, target: ShareTarget) => (place ? placeName(place) : `a folder above ${thisTarget(target)}`);
const LINK_ALLOWS: Record<LinkRole, string> = { viewer: 'can view', commenter: 'can comment on', editor: 'can edit' };

/** Opens the place's own Share dialog in this one's stead. */
const manage = (place: Place) => openShare({ type: 'folder', id: place.id, name: place.name, vault: place.kind === 'vault' });

/** Manage, on a place's heading: the text action, opening that place's own dialog. */
function ManageButton({ place, disabled }: { place: Place; disabled: boolean }): ReactNode {
  return (
    <button type="button" disabled={disabled} aria-label={`Manage ${placeName(place)}`} onClick={() => manage(place)} className={`${ACTION} font-normal`}>
      Manage
    </button>
  );
}

/** A person's or agent's name, its agent tag and (for the owner's view) email, then any extra faint line. */
function Identity({ member, children }: { member: Member; children?: ReactNode }): ReactNode {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-ink-default" title={member.name}>
        {member.name}
        {member.principalType === 'agent' ? <span className="ml-1.5 text-ink-faint">agent</span> : null}
      </p>
      {member.email ? <p className="truncate text-xs text-ink-faint" title={member.email}>{member.email}</p> : null}
      {children}
    </div>
  );
}

/** A heading inside People with access (Pending invites, each place above): faint, with an optional action. */
function SubHeading({ children, action }: { children: string; action?: ReactNode }): ReactNode {
  return (
    <div className="flex min-h-6 items-center justify-between gap-3 pt-2">
      <p className="truncate text-micro text-ink-faint" title={children}>{children}</p>
      {action}
    </div>
  );
}

/**
 * Moss's ModalShell (Settings' 480 px linen dialog), its header naming the place instead of a micro label: the first line
 * a person sees is "Note “Packing list”", and it stays put while the list under it scrolls (T9.46). The dialog's
 * accessible name stays its title.
 */
function ShareShell({ open, onOpenChange, title, description, kind, named, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; kind: string; named: string | null; children: ReactNode;
}): ReactNode {
  const position = useNotePaneDialogPosition({ open, maxWidthPx: 480 });
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogDimOverlay />
        <Dialog.Content
          data-remote-web-surface-blocking-dialog="true"
          style={position}
          className="fixed left-1/2 top-1/2 z-dialog-content flex max-h-modal w-full max-w-modal -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface-linen shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <Dialog.Description className="sr-only">{description}</Dialog.Description>
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <div className="flex shrink-0 items-center justify-between gap-2 px-6 pb-2 pt-4">
            <p className="min-w-0 truncate text-sm text-ink-default" title={named ?? undefined}>
              <span className="text-ink-muted">{kind}</span>
              {named ? ` “${named}”` : null}
            </p>
            <Dialog.Close className="-mr-3 shrink-0 rounded-full p-1 text-ink-faint/60 transition-colors hover:bg-border-subtle hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>
          <div className="space-y-6 overflow-y-auto px-6 pb-8 pt-2 [&::-webkit-scrollbar-thumb:hover]:bg-ink-default/20 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-ink-default/10 [&::-webkit-scrollbar-track]:bg-surface-transparent [&::-webkit-scrollbar]:w-1">
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  // A note's name starts, at every opening, as the title the window shows, so the header names it before the reads
  // answer (T9.50b). The dialog stays mounted while closed, so it is seeded again when `open` turns true.
  const store = useStore();
  const seed = () => (target.type === 'doc' ? shownTitle(store.get(noteEntityAtom(target.id))) : null);
  const [name, setName] = useState<string | null>(seed);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && target.type === 'doc') setName(seed());
  }
  const [inherited, setInherited] = useState<InheritedGroup[]>([]);
  const [linksAbove, setLinksAbove] = useState<LinkAbove[]>([]);
  const [hasAgent, setHasAgent] = useState(false);
  const base = apiBase(target);
  const { title, description, kind, named } = titles(target, name);
  const agentShaped = AGENT_ID.test(email.trim());

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

  // Someone with an agent is told, once, that its ID shares too; a failed read only leaves the hint out.
  useEffect(() => {
    if (!open) return;
    let live = true;
    call<{ agents: unknown[] }>('/api/agents').then((answer) => {
      if (live) setHasAgent(answer.ok && (answer.body?.agents.length ?? 0) > 0);
    }, () => undefined);
    return () => { live = false; };
  }, [open]);

  /** One request at a time; a failure says why, in the section that asked. A change is confirmed as soon as the
   * server takes it, and then the lists are read again. */
  async function run(where: Where, work: () => Promise<string | { text: string; invite: string } | null>, reload = true): Promise<void> {
    if (pending) return;
    setPending(true);
    setStatus(null);
    let took = false;
    try {
      const done = await work();
      took = true;
      if (typeof done === 'string') setStatus({ tone: 'done', text: done, where });
      else if (done) setStatus({ tone: 'done', where, ...done });
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
    // An email has an @; an agent's id is a UUID, copied from Settings → Agents; anything else is not sent.
    if (!address.includes('@') && !AGENT_ID.test(address)) {
      setStatus({ tone: 'error', text: 'Enter a full email address, like name@example.com.', where: 'people' });
      return;
    }
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
      // Invites are copy-link only (PRODUCT ruling 19): say so, and offer the link here.
      const invited = answer.body.shared.email;
      return { text: `Invite link created for ${invited}. No email is sent. Copy the link and send it to them.`, invite: invited };
    });
  }

  /** Changes or removes a member (by id) or an invite (by email); the server closes their windows on a lowering. */
  function changeAccess(who: { principalId: string } | { email: string }, label: string, choice: ShareRole | 'remove'): void {
    void run('email' in who ? 'invites' : 'members', async () => {
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

  // A copy confirms on its own button; only a refused clipboard says anything, in the copy's section.
  const copyFailed = (where: Where, what: string) => () =>
    setStatus({ tone: 'error', text: `Couldn’t copy. Select the ${what} and copy it instead.`, where });
  const statusInvite = status?.invite ? invites.find((invite) => invite.email === status.invite) : undefined;

  return (
    <ShareShell open={open} onOpenChange={onOpenChange} title={title} description={description} kind={kind} named={named}>
      <div className="space-y-2">
        <span className={SECTION_LABEL}>Invite people</span>
        <form aria-label="Share with a person" onSubmit={share} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              aria-label="Email or agent ID"
              placeholder="Email address"
              autoComplete="off"
              value={email}
              readOnly={pending}
              onChange={(event) => setEmail(event.target.value)}
              className={`${FIELD} flex-1 basis-48`}
            />
            <div className="ml-auto flex items-center gap-1">
              <RoleMenu label="Access" roles={agentShaped ? AGENT_ROLES : SHARE_ROLES} value={access} onChange={setAccess} disabled={pending} />
              <button type="submit" disabled={pending} className={ACTION}>
                {agentShaped ? 'Add agent' : 'Create invite link'}
              </button>
            </div>
          </div>
          {hasAgent ? <p className="text-xs text-ink-faint">To share with one of your agents, paste its ID from Settings → Agents.</p> : null}
          <StatusLine status={status} where="people"
            action={status?.invite ? <CopyButton label="Copy invite link" text={statusInvite?.url} onFail={copyFailed('people', 'invite link')} /> : undefined} />
        </form>
      </div>
      <div className="space-y-2">
        <span className={SECTION_LABEL}>People with access</span>
        {loadError ? (
          <p role="alert" className="text-xs text-accent-terracotta">
            {loadError}
          </p>
        ) : members === null ? (
          <p className="text-xs text-ink-faint">Loading…</p>
        ) : (
          <div className="space-y-1">
            <ul aria-label="People with access" className="space-y-2">
              {members.map((member, index) => (
                <li key={member.principalId} className="flex min-h-7 items-center justify-between gap-3">
                  <Identity member={member}>
                    {member.also ? (
                      <p className="text-micro text-ink-faint">Also “{ACCESS_LABEL[member.also.role]}” from {placeRef(member.also.place, target)}</p>
                    ) : null}
                  </Identity>
                  {/* The API lists the vault's owner first; they hold no grant, so their access cannot change. */}
                  {index === 0 ? (
                    <span className={ROLE_TEXT}>{ACCESS_LABEL[member.role]}</span>
                  ) : (
                    <AccessControls who={member.name} role={member.role} disabled={pending}
                      roles={member.principalType === 'agent' ? AGENT_ROLES : SHARE_ROLES}
                      onChoose={(choice) => changeAccess({ principalId: member.principalId }, member.name, choice)} />
                  )}
                </li>
              ))}
            </ul>
            {invites.length > 0 ? (
              <>
                <SubHeading>Pending invites</SubHeading>
                <ul aria-label="Pending invites" className="space-y-3">
                  {invites.map((invite) => (
                    <li key={`invite:${invite.email}`} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-xs text-ink-default" title={invite.email}>{invite.email}</p>
                          <p className="text-micro text-ink-faint">Waiting for them to open the invite link</p>
                        </div>
                        <AccessControls who={invite.email} role={invite.role} disabled={pending}
                          onChoose={(choice) => changeAccess({ email: invite.email }, invite.email, choice)} />
                      </div>
                      {invite.url ? (
                        <div className="flex items-center gap-1">
                          <Input
                            readOnly
                            aria-label={`Invite link for ${invite.email}`}
                            value={invite.url}
                            onFocus={(event) => event.currentTarget.select()}
                            className={`${FIELD} flex-1 text-ink-muted`}
                          />
                          <CopyButton text={invite.url} onFail={copyFailed('invites', 'invite link')} />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="pt-1 text-xs text-ink-faint">
                  An invite link works only for someone signed in with the email it names. Copy it and send it to them.
                </p>
              </>
            ) : null}
            {/* Who reaches it from above, read-only, one heading per place; their access changes in that place's dialog. */}
            {inherited.map((group) => {
              const heading = `From ${placeRef(group.place, target)}`;
              return (
                <div key={group.place?.id ?? 'above'} className="space-y-1">
                  <SubHeading action={group.place ? <ManageButton place={group.place} disabled={pending} /> : undefined}>{heading}</SubHeading>
                  <ul aria-label={heading} className="space-y-2">
                    {group.members.map((member) => (
                      <li key={member.principalId} className="flex min-h-7 items-center justify-between gap-3">
                        <Identity member={member} />
                        <span className={ROLE_TEXT}>{ACCESS_LABEL[member.role]}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        <StatusLine status={status} where="members" />
        <StatusLine status={status} where="invites" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className={SECTION_LABEL}>Share links</span>
          <div className="flex items-center gap-1">
            <RoleMenu label="Link access" roles={LINK_ROLES} value={linkAccess} onChange={setLinkAccess} disabled={pending} />
            <button type="button" disabled={pending} onClick={createLink} className={ACTION}>
              Create link
            </button>
          </div>
        </div>
        {linksAbove.map(({ place, role }) => (
          <div key={place.id} className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-xs text-ink-muted">Anyone with the link to {placeName(place)} {LINK_ALLOWS[role]} {thisTarget(target)}.</p>
            <ManageButton place={place} disabled={pending} />
          </div>
        ))}
        <p className="text-xs text-ink-faint">Anyone with a link can open this. Without signing in they can only view it.</p>
        {links && links.length > 0 ? (
          <ul aria-label="Share links" className="space-y-2">
            {links.map((link) => (
              <li key={link.token} className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
                <span className="w-20 shrink-0 text-xs text-ink-muted">{ACCESS_LABEL[link.role]}</span>
                <Input
                  readOnly
                  aria-label={`${ACCESS_LABEL[link.role]} link`}
                  value={linkUrl(target, link.token)}
                  onFocus={(event) => event.currentTarget.select()}
                  className={`${FIELD} flex-1 basis-40 text-ink-muted`}
                />
                <div className="ml-auto flex items-center gap-1">
                  <CopyButton text={linkUrl(target, link.token)} onFail={copyFailed('links', 'link')} />
                  <button type="button" disabled={pending} onClick={() => revoke(link)} className={ACTION}>
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <StatusLine status={status} where="links" />
      </div>
    </ShareShell>
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

// Settings' Share vault… comes back to Settings when the dialog closes (T9.31).
let onClosed: (() => void) | null = null;

export function openShare(target: ShareTarget, { closed }: { closed?: () => void } = {}): void {
  onClosed = closed ?? null;
  publish(target);
}

const closeShare = () => {
  const closed = onClosed;
  onClosed = null;
  publish(null);
  closed?.();
};

/** Rendered once beside moss's App (boot.tsx). */
export function ShareDialogHost(): ReactNode {
  const target = useSyncExternalStore(subscribe, () => current, () => null);
  const [shown, setShown] = useState<ShareTarget | null>(null);
  // A session that ended under the dialog closes it: the page's banner says how to sign in again.
  const ended = useSessionEnded();
  useEffect(() => {
    if (target) setShown(target);
  }, [target]);
  useEffect(() => {
    if (!ended) return;
    onClosed = null;
    publish(null);
  }, [ended]);
  if (!shown || ended) return null;
  return <ShareDialog key={`${shown.type}:${shown.id}`} target={shown} open={target !== null} onOpenChange={(open) => { if (!open) closeShare(); }} />;
}

/** Whether More actions offers Share…: only an owner shares (A§8), and an ended window no longer can. */
export function useCanShare(docId: string): boolean {
  const role = useDocRole(docId);
  const terminal = useTerminal(docId);
  return role === 'owner' && (terminal === null || terminal === 'conn-limit');
}
