// Settings' Agents section (T3.6, T9.45; A§7, A§8): a named inventory of the person's agent keys, in Moss's
// Connected Folders recipe (a micro label with a header action over a bordered card of icon rows). New key discloses a
// name field; the new key is shown once with Copy key, then each row is the agent's name with Copy ID and Revoke on
// hover or focus. How an agent connects is help behind a text toggle.
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { Input } from '@moss/shared/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { Check, Copy, KeyRound, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAuthState } from '../auth.ts';
import { UNREACHABLE } from '../auth-state.ts';
import { isLeaveCancelled } from '../leave.ts';
import { call } from './ShareDialog.tsx';

interface Agent {
  id: string;
  name: string;
  createdAt: number;
}

const SECTION_LABEL = 'text-micro font-medium uppercase tracking-wider text-ink-faint';
// Moss's Settings text action (Connected Folders' Add).
const ACTION = 'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-border-subtle hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-not-allowed disabled:opacity-60';
// Connected Folders' row action: shown on the row's hover or its own focus, always on a touch screen.
const ROW_ACTION = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 transition-all group-hover/agent:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:opacity-60 [@media(hover:none)]:opacity-100';
const COPY_FAILED = (what: string) => `Couldn’t copy. Select the ${what} and copy it yourself.`;
const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
const created = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Writes `text` to the clipboard; true only once the browser says it landed. */
const copyText = (text: string): Promise<boolean> =>
  Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => true, () => false);

export function AgentsSection(): ReactNode {
  const state = useAuthState();
  const signedIn = state.status === 'signed-in';
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [help, setHelp] = useState(false);
  const [name, setName] = useState('');
  // The show-once key, tied to its agent's id: only that agent's revocation or Done puts it away.
  const [minted, setMinted] = useState<{ id: string; name: string; key: string } | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [idCopied, setIdCopied] = useState<string | null>(null);
  const [shownId, setShownId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Agent | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const newKeyButton = useRef<HTMLButtonElement | null>(null);
  const keyField = useRef<HTMLInputElement | null>(null);
  const idField = useRef<HTMLInputElement | null>(null);

  const reads = useRef(0);
  const load = useCallback(async () => {
    const read = ++reads.current;
    try {
      const answer = await call<{ agents: Agent[] }>('/api/agents');
      if (read !== reads.current) return;
      if (!answer.ok || !answer.body) throw new Error();
      setAgents(answer.body.agents);
    } catch {
      if (read === reads.current) setError('Couldn’t load your agents. Close and open Settings to try again.');
    }
  }, []);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  // An ID shown because the clipboard refused takes focus, selected, for a copy by hand.
  useEffect(() => {
    if (shownId) idField.current?.select();
  }, [shownId]);

  // A closed field, a put-away key or a revoked row hands focus back to New key once it is enabled again.
  const [refocus, setRefocus] = useState(0);
  const refocused = useRef(0);
  useEffect(() => {
    if (pending || refocus === refocused.current) return;
    refocused.current = refocus;
    newKeyButton.current?.focus();
  }, [refocus, pending]);

  if (!signedIn) return null;

  async function run(work: () => Promise<void>): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (failure) {
      // A change the page's leave cut off may have landed: the list says whether it did.
      if (isLeaveCancelled(failure)) void load();
      else setError(failure instanceof Error && failure.message ? failure.message : UNREACHABLE);
    } finally {
      setPending(false);
    }
  }

  const closeForm = () => {
    setCreating(false);
    setName('');
    setRefocus((n) => n + 1);
  };

  function mint(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted) {
      setError('Name the agent first, for example “Claude Code”.');
      return;
    }
    void run(async () => {
      const answer = await call<{ agent: Agent; key: string }>('/api/agents', { method: 'POST', body: JSON.stringify({ name: wanted }) })
        .catch((error: unknown) => { throw isLeaveCancelled(error) ? error : new Error(UNREACHABLE); });
      if (!answer.ok || !answer.body?.key) throw new Error(answer.body?.message ?? 'The key wasn’t created. Try again.');
      setMinted({ id: answer.body.agent.id, name: answer.body.agent.name, key: answer.body.key });
      setKeyCopied(false);
      setCreating(false);
      setName('');
      await load();
    });
  }

  function revoke(agent: Agent): void {
    void run(async () => {
      const answer = await call(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' }).catch((error: unknown) => { throw isLeaveCancelled(error) ? error : new Error(UNREACHABLE); });
      if (!answer.ok) throw new Error(answer.body?.message ?? 'The key wasn’t revoked. Try again.');
      if (minted?.id === agent.id) setMinted(null);
      if (shownId === agent.id) setShownId(null);
      await load();
      setNotice(`Revoked ${agent.name}’s key.`);
      setRefocus((n) => n + 1);
    });
  }

  async function copyKey(key: string): Promise<void> {
    setError(null);
    const ok = await copyText(key);
    setKeyCopied(ok);
    if (ok) return;
    setError(COPY_FAILED('key'));
    keyField.current?.focus();
    keyField.current?.select();
  }

  async function copyId(agent: Agent): Promise<void> {
    setError(null);
    if (await copyText(agent.id)) {
      setIdCopied(agent.id);
      setShownId(null);
      window.setTimeout(() => setIdCopied((was) => (was === agent.id ? null : was)), 1500);
      return;
    }
    setIdCopied(null);
    setShownId(agent.id);
    setError(COPY_FAILED('ID'));
  }

  const collision = creating && name.trim() ? agents?.find((agent) => sameName(agent.name, name)) : undefined;

  return (
    <div data-collab-chrome="" className="space-y-2">
      <div className="flex items-center justify-between">
        <span className={SECTION_LABEL}>Agents</span>
        <button ref={newKeyButton} type="button" className={ACTION} aria-expanded={creating} disabled={pending}
          onClick={() => {
            if (creating) return closeForm();
            setError(null);
            setNotice(null);
            setCreating(true);
          }}>
          <Plus aria-hidden className="h-3.5 w-3.5" />
          <span>New key</span>
        </button>
      </div>
      <div className="rounded-lg border border-border-subtle bg-surface-raised-card p-3">
        {creating ? (
          <form aria-label="New agent key" onSubmit={mint} className="mb-3">
            <div className="flex items-center gap-2">
              <KeyRound aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <Input autoFocus aria-label="Agent name" placeholder="Agent name, e.g. Claude Code" autoComplete="off" maxLength={80}
                value={name} readOnly={pending}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  event.stopPropagation();
                  closeForm();
                }}
                className="h-7 min-w-0 flex-1 px-1.5 text-xs" />
              <button type="submit" className={ACTION} disabled={pending}>Create key</button>
            </div>
            {collision ? (
              <p className="mt-1.5 text-xs text-ink-faint">
                You already have an agent named “{collision.name}”. This makes a second key; the first keeps working.
              </p>
            ) : null}
          </form>
        ) : null}
        {minted ? (
          <div className="mb-3 space-y-1.5 border-b border-border-subtle pb-3">
            <p className="text-xs font-medium text-ink-default">Key for {minted.name}</p>
            <div className="flex items-center gap-1">
              <Input ref={keyField} readOnly aria-label={`API key for ${minted.name}`} value={minted.key}
                onFocus={(event) => event.currentTarget.select()}
                className="h-7 min-w-0 flex-1 px-1.5 font-mono text-xs" />
              <button type="button" className={ACTION} onClick={() => void copyKey(minted.key)}>
                {keyCopied ? 'Copied' : 'Copy key'}
              </button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-ink-faint">Copy this key now. It won’t be shown again.</p>
              <button type="button" className={ACTION}
                onClick={() => { setMinted(null); setRefocus((n) => n + 1); }}>
                Done
              </button>
            </div>
          </div>
        ) : null}
        {agents === null ? (
          error ? null : <p className="text-xs text-ink-faint">Loading…</p>
        ) : agents.length === 0 ? (
          <p className="text-xs text-ink-faint">No agents yet.</p>
        ) : (
          <TooltipProvider delayDuration={400}>
            <ul aria-label="Agents" className="space-y-1.5">
              {agents.map((agent) => (
                <li key={agent.id} className="group/agent">
                  <div className="flex min-w-0 items-center gap-2">
                    <KeyRound aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={agent.name}>{agent.name}</span>
                    {agents.some((other) => other.id !== agent.id && sameName(other.name, agent.name)) ? (
                      <span className="shrink-0 text-xs text-ink-faint">{created(agent.createdAt)}</span>
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" aria-label={`Copy ID for ${agent.name}`} className={`${ROW_ACTION} hover:text-ink-muted`}
                          onClick={() => void copyId(agent)}>
                          {idCopied === agent.id ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">{idCopied === agent.id ? 'Copied' : 'Copy ID'}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" aria-label={`Revoke ${agent.name}`} disabled={pending}
                          className={`${ROW_ACTION} hover:text-accent-terracotta`} onClick={() => setRevoking(agent)}>
                          <X aria-hidden className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="text-xs">Revoke key</TooltipContent>
                    </Tooltip>
                  </div>
                  {shownId === agent.id ? (
                    <Input ref={idField} readOnly aria-label={`Agent ID for ${agent.name}`} value={agent.id}
                      onFocus={(event) => event.currentTarget.select()}
                      className="ml-5 mt-1 h-7 w-[calc(100%-1.25rem)] px-1.5 font-mono text-xs" />
                  ) : null}
                </li>
              ))}
            </ul>
          </TooltipProvider>
        )}
        <p className="mt-2 text-xs text-ink-faint">
          An agent acts with your access and shows as Bot where it works.{' '}
          <button type="button" aria-expanded={help} onClick={() => setHelp(!help)}
            className="rounded text-ink-muted underline-offset-2 hover:text-ink-default hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
            How agents connect
          </button>
        </p>
        {help ? (
          <p className="mt-1.5 text-xs text-ink-faint">
            Sign the agent in to the moss-multi CLI with its key. To give it a role of its own on something you share, copy its
            ID and add it in Share.
          </p>
        ) : null}
      </div>
      {error !== null ? <p role="alert" className="text-xs text-accent-terracotta">{error}</p> : null}
      <p role="status" className={notice ? 'text-xs text-ink-faint' : 'sr-only'}>{notice}</p>
      <ConfirmationDialog
        open={revoking !== null}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        title={`Revoke ${revoking?.name ?? ''}’s key?`}
        description="The key stops working at once, and anything signed in with it is disconnected."
        confirmLabel="Revoke key"
        cancelLabel="Cancel"
        variant="danger"
        cancelAutoFocus
        onConfirm={() => { if (revoking) revoke(revoking); }}
      />
    </div>
  );
}
