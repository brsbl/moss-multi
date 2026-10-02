// The 9 global invariants (A§20, S-test §3.5), checked on every actor of every journey. Each check is a pure
// function of telemetry or a browser-side detector, and e2e/selftest proves each one can fail.
import type { Page } from '@playwright/test';
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

const declares = (declared: DeclaredHttp[], status: number, url: string) =>
  declared.some((d) => d.status === status && pathMatches(url, d.path));

/** Invariant 1: page errors, console errors (unless allowlisted), 5xx, and 4xx unless declared. */
export function errorProblems(
  census: { console: ConsoleEntry[]; pageErrors: PageError[]; http: HttpEntry[] },
  declared: DeclaredHttp[],
  journey: string,
): string[] {
  const problems = census.pageErrors.map((e) => `page error: ${e.message}`);
  for (const entry of census.console) {
    if (entry.type !== 'error') continue;
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

/** Invariant 3: per doc and document, at most one open doc socket at a time and at most 1 + declared opens. */
export function socketProblems(sockets: SocketEntry[], reconnects: Map<string, number>): string[] {
  const groups = new Map<string, SocketEntry[]>();
  for (const socket of sockets) {
    const key = `${socket.epoch}\u0000${socket.docId}`;
    groups.set(key, [...(groups.get(key) ?? []), socket]);
  }
  const problems: string[] = [];
  for (const group of groups.values()) {
    const { docId } = group[0];
    const allowed = 1 + (reconnects.get(docId) ?? 0) + (reconnects.get('*') ?? 0);
    if (group.length > allowed) problems.push(`${docId}: ${group.length} socket opens in one document, ${allowed} allowed`);
    const events = group.flatMap((s) => [[s.openedAt, 1], [s.closedAt ?? Number.POSITIVE_INFINITY, -1]] as const);
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0;
    let peak = 0;
    for (const [, delta] of events) peak = Math.max(peak, (open += delta));
    if (peak > 1) problems.push(`${docId}: ${peak} doc sockets open at once`);
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
export async function actorFindings(actor: ActorView, journey: string, version: Provenance | null): Promise<Finding[]> {
  await actor.telemetry.settle();
  if (!actor.page.isClosed()) await actor.telemetry.stamp(actor.page);
  const findings = [
    ...errorProblems(actor.telemetry, actor.declaredHttp, journey).map(finding(1, actor.label)),
    ...stampProblems(actor.telemetry.stamps, version).map(finding(2, actor.label)),
    ...socketProblems(actor.telemetry.sockets, actor.reconnects).map(finding(3, actor.label)),
  ];
  if (actor.page.isClosed()) return findings;
  for (const [docId, { mark, generation }] of actor.observations) {
    const problems = await actor.page.evaluate(remountSince, { names: NAMES, docId, mark, generation });
    findings.push(...problems.map(finding(4, actor.label)));
  }
  return [...findings, ...(await domFindings(actor))];
}

/** Invariant 7: every typed string, exactly once and in order, on every actor that has the doc open. */
export async function typedFindings(actors: ActorView[], typed: Typed[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const docs = [...new Set(typed.map((entry) => entry.docId))];
  for (const actor of actors) {
    if (actor.page.isClosed()) continue;
    for (const docId of docs) {
      const panes = await actor.page.evaluate(fieldTexts, { names: NAMES, docId });
      for (const pane of panes) {
        for (const field of ['title', 'body'] as const) {
          const entries = typed.filter((entry) => entry.docId === docId && entry.field === field);
          if (entries.length === 0) continue;
          findings.push(...typedProblems(pane[field], entries).map((detail) => finding(7, actor.label)(`${docId} ${field}: ${detail}`)));
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
