// Settings' Agents section (T3.6; A§7, A§8): mint an agent key, shown once; list the live agents, each with the id a
// Share dialog takes; revoke one, which closes its connections. Moss has no agents, so it follows glyphdown's
// Settings → Agents in moss's own Settings vocabulary: a micro label over a bordered card, as Connected Folders.
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import { Button } from '@moss/shared/components/ui/button';
import { Input } from '@moss/shared/components/ui/input';
import { KeyRound, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAuthState } from '../auth.ts';

interface Agent {
  id: string;
  name: string;
  createdAt: number;
}

const UNREACHABLE = 'Couldn’t reach the server. Check your connection and try again.';

async function call<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; body: (T & { message?: string }) | null }> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  return { ok: response.ok, body: (await response.json().catch(() => null)) as (T & { message?: string }) | null };
}

/** A read-only value with a Copy button; the field is selectable, since a browser may refuse the clipboard. */
function CopyField({ label, value }: { label: string; value: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Input
        readOnly
        aria-label={label}
        value={value}
        onFocus={(event) => event.currentTarget.select()}
        className="h-7 min-w-0 flex-1 border-border-default font-mono text-xs"
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false))}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export function AgentsSection(): ReactNode {
  const state = useAuthState();
  const signedIn = state.status === 'signed-in';
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<{ name: string; key: string } | null>(null);
  const [revoking, setRevoking] = useState<Agent | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (!signedIn) return null;

  async function run(work: () => Promise<void>): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : UNREACHABLE);
    } finally {
      setPending(false);
    }
  }

  function mint(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted) {
      setError('Name the agent first, for example “Claude Code”.');
      return;
    }
    void run(async () => {
      const answer = await call<{ agent: Agent; key: string }>('/api/agents', { method: 'POST', body: JSON.stringify({ name: wanted }) })
        .catch(() => { throw new Error(UNREACHABLE); });
      if (!answer.ok || !answer.body?.key) throw new Error(answer.body?.message ?? 'The key wasn’t created. Try again.');
      setMinted({ name: answer.body.agent.name, key: answer.body.key });
      setName('');
      await load();
    });
  }

  function revoke(agent: Agent): void {
    void run(async () => {
      const answer = await call(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' }).catch(() => { throw new Error(UNREACHABLE); });
      if (!answer.ok) throw new Error(answer.body?.message ?? 'The key wasn’t revoked. Try again.');
      if (minted?.name === agent.name) setMinted(null);
      await load();
    });
  }

  return (
    <div data-collab-chrome="" className="space-y-2">
      <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Agents</span>
      <div className="space-y-3 rounded-lg border border-border-subtle bg-surface-raised-card p-3">
        <p className="text-xs text-ink-muted">
          An agent signs in to the moss-multi CLI with its key and acts with your access. To give it a role of its own on
          something you share, add its ID in Share.
        </p>
        <form aria-label="New agent key" onSubmit={mint} className="flex items-center gap-2">
          <Input
            aria-label="Agent name"
            placeholder="Agent name, e.g. Claude Code"
            autoComplete="off"
            maxLength={80}
            value={name}
            readOnly={pending}
            onChange={(event) => setName(event.target.value)}
            className="h-8 min-w-0 flex-1 border-border-default text-xs"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={pending}>
            New key
          </Button>
        </form>
        {minted ? (
          <div className="space-y-1.5 rounded-md border border-border-default p-2">
            <p className="text-xs font-medium text-ink-default">Key for {minted.name}</p>
            <div className="flex items-center gap-1">
              <CopyField label={`API key for ${minted.name}`} value={minted.key} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setMinted(null)}>
                Done
              </Button>
            </div>
            <p className="text-xs text-ink-muted">Copy this key now. It won’t be shown again.</p>
          </div>
        ) : null}
        {agents === null ? (
          error ? null : <p className="text-xs text-ink-faint">Loading…</p>
        ) : agents.length === 0 ? (
          <p className="text-xs text-ink-faint">No agents yet.</p>
        ) : (
          <ul aria-label="Agents" className="space-y-1.5">
            {agents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-2">
                <KeyRound aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="w-24 shrink-0 truncate text-xs text-ink-default" title={agent.name}>{agent.name}</span>
                <CopyField label={`Agent ID for ${agent.name}`} value={agent.id} />
                <button
                  type="button"
                  aria-label={`Revoke ${agent.name}`}
                  title="Revoke key"
                  disabled={pending}
                  onClick={() => setRevoking(agent)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:text-accent-terracotta focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:opacity-60"
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-accent-terracotta">
            {error}
          </p>
        )}
      </div>
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
