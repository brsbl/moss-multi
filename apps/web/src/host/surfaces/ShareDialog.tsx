// Share, v1 (T1.1): the owner's Share button in the note's top bar opens a dialog that adds a person by email at view,
// comment or edit access and lists who has access. Moss has no sharing, so the layout follows glyphdown's
// ShareDialog (docs/design/glyphdown-reference.md), built from moss's own parts: Settings' ModalShell, section labels
// and cards, its segmented choice for the access level, and the DS Input and Button. Links, changing or removing
// access, and folder and vault sharing come with T2.4.
import { ModalShell } from '@moss-desktop/renderer/components/ModalShell';
import { Button } from '@moss/shared/components/ui/button';
import { Input } from '@moss/shared/components/ui/input';
import { SHARE_ROLES, type Role, type ShareRole } from '@moss-multi/protocol/roles';
import { UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useDocRole } from '../access.ts';

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

type Status = { tone: 'error' | 'done'; text: string } | null;

const SECTION_LABEL = 'text-micro font-medium uppercase tracking-wider text-ink-faint';
const CARD = 'rounded-lg border border-border-subtle bg-surface-raised-card p-3';

/** Settings' segmented choice (AppearanceSection), here for the access a share grants. */
function AccessChoice({ value, onChange, disabled }: { value: ShareRole; onChange: (role: ShareRole) => void; disabled: boolean }): ReactNode {
  return (
    <div role="radiogroup" aria-label="Access" className="inline-flex items-center gap-0.5 rounded-lg bg-surface-raised-control p-0.5">
      {SHARE_ROLES.map((role) => {
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

function ShareDialog({ docId, open, onOpenChange }: { docId: string; open: boolean; onOpenChange: (open: boolean) => void }): ReactNode {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [access, setAccess] = useState<ShareRole>('editor');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const path = `/api/docs/${encodeURIComponent(docId)}/members`;

  const load = useCallback(async () => {
    try {
      const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      setMembers(((await response.json()) as { members: Member[] }).members);
      setLoadError(null);
    } catch {
      setLoadError('Couldn’t load who has access. Close and open Share to try again.');
    }
  }, [path]);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    void load();
  }, [open, load]);

  async function share(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (!email.trim()) {
      setStatus({ tone: 'error', text: 'Enter an email address.' });
      return;
    }
    setPending(true);
    setStatus(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: email.trim(), role: access }),
      });
      const body = (await response.json().catch(() => null)) as { member?: Member; message?: string } | null;
      if (!response.ok || !body?.member) {
        setStatus({ tone: 'error', text: body?.message ?? 'Sharing didn’t work. Try again.' });
        return;
      }
      setEmail('');
      setStatus({ tone: 'done', text: `${body.member.name} ${ACCESS_LABEL[body.member.role].toLowerCase()}.` });
      await load();
    } catch {
      setStatus({ tone: 'error', text: UNREACHABLE });
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalShell open={open} onOpenChange={onOpenChange} title="Share" description="Share this note with people by email, at the access you choose.">
      <div className="space-y-2">
        <span className={SECTION_LABEL}>Invite people</span>
        <form aria-label="Share with a person" onSubmit={(event) => void share(event)} className={`${CARD} space-y-3`}>
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
            <AccessChoice value={access} onChange={setAccess} disabled={pending} />
            <Button type="submit" size="sm" disabled={pending}>
              Share
            </Button>
          </div>
          {status ? (
            <p role={status.tone === 'error' ? 'alert' : 'status'} className={status.tone === 'error' ? 'text-xs text-accent-terracotta' : 'text-xs text-ink-muted'}>
              {status.text}
            </p>
          ) : null}
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
            </ul>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

/** The top bar's Share button and its dialog; only the owner shares (A§8), so nobody else is offered it. */
export function ShareControl({ docId }: { docId: string }): ReactNode {
  const role = useDocRole(docId);
  const [open, setOpen] = useState(false);
  if (role !== 'owner') return null;
  return (
    <>
      <button
        type="button"
        data-collab-chrome=""
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs font-medium text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
      >
        <UserPlus aria-hidden className="h-3.5 w-3.5" />
        Share
      </button>
      <ShareDialog docId={docId} open={open} onOpenChange={setOpen} />
    </>
  );
}
