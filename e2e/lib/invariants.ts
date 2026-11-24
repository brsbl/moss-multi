// The 9 global invariants (A§20, S-test §3.5), checked on every actor of every journey. Each check is a pure
// function of telemetry or a browser-side detector, and e2e/selftest proves each one can fail.
import type { Page } from '@playwright/test';
import { DROP_ALLOWANCE } from '../../scripts/deploy/network-drops.mjs';
import { isAllowed } from './allowlist.ts';
import { NAMES } from './contract.ts';
import { editableUnbound, fieldTexts, floatingOverCanvas, markerLeak, remountSince } from './detectors.js';
import { principalProblems, type Principal } from './principals.ts';
import type { Provenance } from './stack.ts';
import type { ConsoleEntry, HttpEntry, PageError, SocketEntry, StampEntry, Telemetry } from './telemetry.ts';
import { typedProblems, type Typed } from './text.ts';

export interface Finding { invariant: number; actor: string; detail: string }

export interface DeclaredHttp { status: number; path: string | RegExp }

/** What the checks need from an actor; Actor implements it. */
export interface ActorView {
  label: string;
  page: Page;
  telemetry: Telemetry;
  declaredHttp: DeclaredHttp[];
  /** Declared reconnects per doc id (`*` for every doc). */
  reconnects: Map<string, number>;
  /** Declared try-again (1013) closes per doc id (`*` for every doc), judged off loopback (invariant 3). */
  tryAgain?: Map<string, number>;
  /** Editor observations per doc id (invariant 4). */
  observations: Map<string, { mark: string; generation: string }>;
}

const finding = (invariant: number, actor: string) => (detail: string): Finding => ({ invariant, actor, detail });

export const pathMatches = (url: string, path: string | RegExp): boolean => {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // keep the raw text
  }
  return typeof path === 'string' ? pathname === path : path.test(pathname);
};

const LOAD_FAILURE = /Failed to load resource: the server responded with a status of (\d{3})/;

export const declares = (declared: DeclaredHttp[], status: number, url: string) =>
  declared.some((d) => d.status === status && pathMatches(url, d.path));

/** A doc socket the network dropped: the close the page heard was abnormal. */
const NETWORK_DROP = 1006;
/**
 * The network dropped it: it heard 1006 without the page asking to close it. A socket the page closes while still
 * connecting (a note switch or navigation before the handshake ends, which off loopback takes a round trip) hears 1006
 * too, by the WebSocket spec; that is the page's own close, judged as any other.
 */
const networkDropped = (socket: SocketEntry): boolean => socket.code === NETWORK_DROP && !socket.close?.startsWith('asked');
/** The server's try-again (packages/sync access-epoch.ts TRY_AGAIN): a close no journey sees unless it declares it. */
const TRY_AGAIN = 1013;
const SOCKET_FAILED = /^WebSocket connection to '([^']+)' failed/;
/** How long after its socket closed the browser's console line about the failure may arrive. */
const FAILED_LOG_MS = 2_000;

export interface Network {
  /**
   * Against a deployed stack: a network drop recovered to sync is the reconnect path working, not a finding (A§21). Each
   * is listed in the run's summary, and a run allows DROP_ALLOWANCE of them (scripts/deploy/network-drops.mjs).
   */
  offLoopback?: boolean;
  /**
   * Docs whose replica, after a recovered drop, did not show what the server serves (Actors.compareExports): their drop
   * did not recover to an identical export, so it is a finding, not the reconnect path working.
   */
  diverged?: ReadonlySet<string>;
}

/** The later socket of its doc and document that received the server's sync step 2 first, if any. */
const replacement = (dropped: SocketEntry, group: SocketEntry[]): SocketEntry | undefined =>
  group.filter((s) => s !== dropped && s.openedAt >= dropped.openedAt && s.synced === true)
    .sort((a, b) => (a.syncedAt ?? a.openedAt) - (b.syncedAt ?? b.openedAt))[0];

/** A dropped socket is recovered when a later socket of its doc and document received the server's sync step 2. */
const recovered = (dropped: SocketEntry, group: SocketEntry[]): boolean => replacement(dropped, group) !== undefined;

export interface NetworkDrop {
  docId: string; at: number; recovered: boolean; recoveryMs: number | null;
  /** After the resync: the replica showed what the server serves (`same`), did not (`different`), or no pane was open. */
  export?: 'same' | 'different' | 'closed';
}

/**
 * Every network drop (a heard 1006) in a census: when it closed, and whether and how fast a later socket resynced. With
 * `exports`, each resynced drop also names what the export comparison found; a `different` one did not recover.
 */
export function networkDrops(sockets: SocketEntry[], exports?: ReadonlyMap<string, 'same' | 'different' | 'closed'>): NetworkDrop[] {
  return [...socketGroups(sockets).values()].flatMap((group) => group.filter(networkDropped).map((drop) => {
    const at = drop.closedAt ?? drop.openedAt;
    const next = replacement(drop, group);
    const syncedAt = next?.syncedAt;
    const found = next === undefined ? undefined : exports?.get(drop.docId);
    return {
      docId: drop.docId, at, recovered: next !== undefined && found !== 'different', recoveryMs: syncedAt === undefined ? null : Math.max(0, syncedAt - at),
      ...(found ? { export: found } : {}),
    };
  }));
}

/** The docs of a census's drops that resynced: the ones whose replica Actors compares with the server's export. */
export const resyncedDocs = (sockets: SocketEntry[]): string[] =>
  [...new Set(networkDrops(sockets).filter((drop) => drop.recovered).map((drop) => drop.docId))];

/**
 * Off loopback, whether a 1006 drop has not recovered yet: no later socket of its doc and document reached sync. Its
 * replacement may still be connecting, or not yet opened while the client waits out its reconnect delay. The
 * invariants wait a bounded time for it before they judge the drop (actors.ts).
 */
export const awaitingRecovery = (sockets: SocketEntry[]): boolean =>
  [...socketGroups(sockets).values()].some((group) => group.some((s) => networkDropped(s) && !recovered(s, group)));

/** Invariant 3's socket groups: per page document (else navigation count) and doc. */
const socketGroups = (sockets: SocketEntry[]): Map<string, SocketEntry[]> => {
  const groups = new Map<string, SocketEntry[]>();
  for (const socket of sockets) {
    const key = `${socket.document ? `doc:${socket.document}` : `epoch:${socket.epoch}`}\u0000${socket.docId}`;
    groups.set(key, [...(groups.get(key) ?? []), socket]);
  }
  return groups;
};

/**
 * Off loopback, the recovered network drops: each 1006 whose replacement reached sync. Only the browser's own failure
 * line for that socket, logged while it lived or just after, is left to invariant 3.
 */
const recoveredDrops = (sockets: SocketEntry[]): SocketEntry[] =>
  [...socketGroups(sockets).values()].flatMap((group) => group.filter((s) => networkDropped(s) && recovered(s, group)));

/** The sockets the page closed while they were still connecting: the browser logs that failure as its own. */
const closedConnecting = (sockets: SocketEntry[]): SocketEntry[] =>
  sockets.filter((s) => s.code === NETWORK_DROP && !!s.close?.startsWith('asked'));

/** Invariant 1: page errors, console errors (unless allowlisted), 5xx, and 4xx unless declared. */
export function errorProblems(
  census: { console: ConsoleEntry[]; pageErrors: PageError[]; http: HttpEntry[]; sockets?: SocketEntry[] },
  declared: DeclaredHttp[],
  journey: string,
  { offLoopback = false }: Network = {},
): string[] {
  const problems = census.pageErrors.map((e) => `page error: ${e.message}`);
  const dropped = offLoopback ? [...recoveredDrops(census.sockets ?? []), ...closedConnecting(census.sockets ?? [])] : [];
  for (const entry of census.console) {
    if (entry.type !== 'error') continue;
    // The browser logs the drop invariant 3 judges, or the page's own close of a socket still connecting: that
    // socket's URL (its own _pk), while it lived or just after.
    const failed = SOCKET_FAILED.exec(entry.text)?.[1];
    if (failed && dropped.some((s) => s.url === failed && entry.at >= s.openedAt && entry.at <= (s.closedAt ?? s.openedAt) + FAILED_LOG_MS)) continue;
    // A declared 4xx also logs a load failure for that resource; it is the same, declared, event.
    const load = LOAD_FAILURE.exec(entry.text);
    const status = load ? Number(load[1]) : 0;
    if (status && status < 500 && (entry.url ? declares(declared, status, entry.url) : declared.some((d) => d.status === status))) continue;
    if (isAllowed(entry.text, journey)) continue;
    problems.push(`console error: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`);
  }
  for (const response of census.http) {
    if (response.status < 500 && declares(declared, response.status, response.url)) continue;
    problems.push(`HTTP ${response.status} ${response.method} ${response.url}${response.status < 500 ? ' (undeclared)' : ''}`);
  }
  return problems;
}

/** Invariant 2: every 200 document carries meta and client stamps equal to `/api/version`. */
export function stampProblems(stamps: StampEntry[], version: Provenance | null): string[] {
  const documents = stamps.filter((s) => /^https?:/.test(s.url) && (s.status === null || s.status === 200));
  if (documents.length === 0) return [];
  if (!version) return ['no /api/version to compare the build stamps with'];
  const meta = `${version.commit}:${version.bundleHash}`;
  const client = `${version.commit}:${version.clientHash}`;
  return documents.flatMap((s) => [
    ...(s.meta === meta ? [] : [`${s.url}: meta moss-build is ${s.meta ?? 'missing'}, /api/version says ${meta}`]),
    ...(s.client === client ? [] : [`${s.url}: html data-client-build is ${s.client ?? 'missing'}, /api/version says ${client}`]),
  ]);
}

/** The longest a socket the page never saw close may have lived and still be a browser artifact (invariant 3). */
const ARTIFACT_MS = 50;

/**
/**
 * The sockets the page opened. A socket the browser reported closed within ARTIFACT_MS of opening, that the page never
 * closed nor heard close, is not one the page opened: a WebKit census once listed such a socket, closed 1 ms after it
 * opened, beside the page's only one (run 38332852937). A longer-lived socket counts even unheard: a navigation closes
 * sockets unreported.
 */
export const pageSockets = (sockets: SocketEntry[]): SocketEntry[] =>
  sockets.filter((s) => s.closedAt === null || s.close !== null || s.closedAt - s.openedAt > ARTIFACT_MS);

/**
 * Invariant 3: per doc and document, at most one open doc socket at a time and at most 1 + declared opens. A socket's
 * document is the one the page reported constructing it, else the navigation count when it was seen. Off loopback, a
 * network drop (a heard 1006) is allowed, with the reopen it causes, only when a later socket of that document reached
 * sync, and at most DROP_ALLOWANCE of them (the run's allowance, so one leg past it already fails the run); every 1013
 * (the server's try-again) is a finding unless the journey declared it (`expectTryAgain`).
 */
export function socketProblems(
  sockets: SocketEntry[],
  reconnects: Map<string, number>,
  { offLoopback = false, diverged = new Set() }: Network = {},
  tryAgain: Map<string, number> = new Map(),
): string[] {
  const groups = socketGroups(sockets);
  const problems: string[] = [];
  const tryAgainSeen = new Map<string, number>();
  let recoveredSeen = 0;
  for (const all of groups.values()) {
    const { docId } = all[0];
    const group = pageSockets(all);
    if (group.length === 0) continue;
    let drop = 0;
    if (offLoopback) {
      for (const socket of group) {
        if (socket.code === TRY_AGAIN) tryAgainSeen.set(docId, (tryAgainSeen.get(docId) ?? 0) + 1);
      }
      for (const socket of group.filter(networkDropped)) {
        if (!recovered(socket, group)) problems.push(`${docId}: a socket dropped (1006) and no later socket of its document reached sync`);
        else if (diverged.has(docId)) problems.push(`${docId}: a socket dropped (1006) and resynced, but its replica differs from the server's export`);
        else drop += 1;
      }
      recoveredSeen += drop;
    }
    const allowed = 1 + (reconnects.get(docId) ?? 0) + (reconnects.get('*') ?? 0) + drop;
    if (group.length > allowed) {
      // How each socket ended, for a log that may not print the census.
      const closes = group.map((s, i) => `#${i + 1} ${s.closedAt === null ? 'open' : `closed after ${s.closedAt - s.openedAt} ms: ${s.close ?? 'no close event'}`}`);
      problems.push(`${docId}: ${group.length} socket opens in one document, ${allowed} allowed (${group.filter((s) => s.error).length} errored; ${closes.join('; ')})`);
    }
    const events = group.flatMap((s) => [[s.openedAt, 1], [s.closedAt ?? Number.POSITIVE_INFINITY, -1]] as const);
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0;
    let peak = 0;
    for (const [, delta] of events) peak = Math.max(peak, (open += delta));
    if (peak > 1) problems.push(`${docId}: ${peak} doc sockets open at once`);
  }
  if (recoveredSeen > DROP_ALLOWANCE) problems.push(`${recoveredSeen} recovered network drops (1006), ${DROP_ALLOWANCE} allowed in a run`);
  for (const [docId, seen] of tryAgainSeen) {
    const declared = (tryAgain.get(docId) ?? 0) + (tryAgain.get('*') ?? 0);
    if (seen > declared) problems.push(`${docId}: ${seen} try-again closes (1013), ${declared} declared`);
  }
  return problems;
}

/** Invariants 5, 6 and 9: the cheap DOM checks `checkpoint()` also runs mid-test. */
export async function domFindings(actor: ActorView): Promise<Finding[]> {
  const page = actor.page;
  if (page.isClosed()) return [];
  return [
    ...(await page.evaluate(floatingOverCanvas, { names: NAMES })).map(finding(5, actor.label)),
    ...(await page.evaluate(markerLeak, { names: NAMES })).map(finding(6, actor.label)),
    ...(await page.evaluate(editableUnbound, { names: NAMES })).map(finding(9, actor.label)),
  ];
}

/** Invariants 1-6 and 9 for one actor. */
export async function actorFindings(actor: ActorView, journey: string, version: Provenance | null, network: Network = {}): Promise<Finding[]> {
  await actor.telemetry.settle();
  if (!actor.page.isClosed()) await actor.telemetry.stamp(actor.page);
  const findings = [
    ...errorProblems(actor.telemetry, actor.declaredHttp, journey, network).map(finding(1, actor.label)),
    ...stampProblems(actor.telemetry.stamps, version).map(finding(2, actor.label)),
    ...socketProblems(actor.telemetry.sockets, actor.reconnects, network, actor.tryAgain).map(finding(3, actor.label)),
  ];
  if (actor.page.isClosed()) return findings;
  for (const [docId, { mark, generation }] of actor.observations) {
    const problems = await actor.page.evaluate(remountSince, { names: NAMES, docId, mark, generation });
    findings.push(...problems.map(finding(4, actor.label)));
  }
  return [...findings, ...(await domFindings(actor))];
}

/** How long invariant 7 waits for a field that is binding or rebinding (A§19), one mounting after a note switch among
 * them, before it judges it. */
export const BIND_WAIT_MS = 15_000;

type Field = 'title' | 'body';
type Pane = Awaited<ReturnType<typeof fieldTexts>>[number];
const bindingOf = (pane: Pane, field: Field) => (field === 'title' ? pane.titleBinding : pane.bodyBinding);

/**
 * Invariant 7: every typed string, exactly once and in order, on every actor that has the doc open. A field still
 * binding or rebinding shows no doc text yet, so the check waits for it to bind (at most `settleMs` across the whole
 * check) and then reads it; one that never binds is its own finding, not a missing string, unless it already shows
 * what was typed.
 */
export async function typedFindings(actors: ActorView[], typed: Typed[], { settleMs = BIND_WAIT_MS }: { settleMs?: number } = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const docs = [...new Set(typed.map((entry) => entry.docId))];
  const deadline = Date.now() + settleMs;
  for (const actor of actors) {
    for (const docId of docs) {
      const fields = (['title', 'body'] as const).filter((field) => typed.some((entry) => entry.docId === docId && entry.field === field));
      // A page mid-navigation has no context to read; it is read again until the deadline.
      const read = async (): Promise<Pane[] | null> => {
        if (actor.page.isClosed()) return [];
        return actor.page.evaluate(fieldTexts, { names: NAMES, docId }).catch((error: unknown) => {
          if (Date.now() >= deadline) throw error;
          return null;
        });
      };
      const pending = (shown: Pane[] | null) => shown === null || shown.some((pane) => fields.some((field) => bindingOf(pane, field) === 'unbound'));
      let panes = await read();
      while (pending(panes) && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 250));
        panes = await read();
      }
      panes ??= await read() ?? [];
      for (const pane of panes) {
        for (const field of fields) {
          const report = finding(7, actor.label);
          const entries = typed.filter((entry) => entry.docId === docId && entry.field === field);
          const problems = typedProblems(pane[field], entries);
          if (bindingOf(pane, field) === 'unbound') {
            if (problems.length > 0) {
              findings.push(report(`${docId} ${field}: still unbound after ${settleMs / 1000} s, pane never bound (title "${pane.title}", body ${pane.body.length} chars)`));
            }
            continue;
          }
          findings.push(...problems.map((detail) => report(`${docId} ${field}: ${detail}`)));
        }
      }
    }
  }
  return findings;
}

/** Invariant 8. */
export function principalFindings(principals: Principal[], solo: string | null): Finding[] {
  return principalProblems(principals, solo).map(finding(8, 'journey'));
}
