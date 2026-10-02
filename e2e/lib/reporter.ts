// The run summary (S-test §2.6): provenance and the shard, one row per test with latencies and invariant counts,
// slow tests, BLOCKED (infra) kept apart from FAILED, and latency and duration percentiles (the p95 headroom
// table). Written to test-results/summary.md (in the CI artifact, which gh can download) and to
// $GITHUB_STEP_SUMMARY in CI. A journey-group shard that plans no journey fails the run.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { isInfraBlocked } from './infra.ts';
import { latencyRows, type LatencyRow, type LatencySample } from './measure.ts';

interface Row {
  project: string;
  title: string;
  status: string;
  ms: number;
  timeoutMs: number;
  latencies: LatencySample[];
  findings: number | null;
  blocked: boolean;
}

const SLOW_MS = 90_000;
const WHOLE_SUITE = 'all';

const isJourneyProject = (name: string) => !name.startsWith('selftest-') && name !== 'parity';

/** A journey-group shard that plans no journey test (a group or testMatch mistake) must not pass on selftests alone. */
export function emptyShardProblem(group: string | undefined, planned: number): string | null {
  if (!group || group === WHOLE_SUITE || planned > 0) return null;
  return `shard ${group} planned no journey test: check GROUPS in scripts/ci/journeys.mjs and the E2E_GROUP testMatch`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const millis = (ms: number) => `${Math.round(ms)} ms`;

function percentileTable(title: string, first: string, rows: LatencyRow[], unit: (ms: number) => string): string[] {
  if (rows.length === 0) return [];
  return [
    `#### ${title}`,
    '',
    `| ${first} | Project | n | p50 | p95 | max | Budget | Headroom |`,
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) =>
      `| ${r.name.replace(/\|/g, '\\|')} | ${r.project} | ${r.n} | ${unit(r.p50)} | ${unit(r.p95)} | ${unit(r.max)} | ${r.budgetMs === null ? '' : unit(r.budgetMs)} | ${r.headroom === null ? '' : `${r.headroom}x`} |`,
    ),
    '',
  ];
}

export default class MossReporter implements Reporter {
  private rows: Row[] = [];
  private browsers = new Map<string, string>();
  private outputDir = 'test-results';
  private plannedJourneys = 0;

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.outputDir = config.projects[0]?.outputDir ?? join(config.rootDir, 'test-results');
    this.plannedJourneys = suite.suites
      .filter((project) => isJourneyProject(project.project()?.name ?? ''))
      .reduce((sum, project) => sum + project.allTests().length, 0);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? '';
    const annotations = result.annotations;
    const browser = annotations.find((a) => a.type === 'browser')?.description;
    if (browser && !this.browsers.has(project)) this.browsers.set(project, browser);
    const latencies = annotations
      .filter((a) => a.type === 'latency')
      .map((a) => ({ project, ...(JSON.parse(a.description ?? '{}') as Omit<LatencySample, 'project'>) }));
    const invariants = annotations.find((a) => a.type === 'invariants')?.description;
    this.rows.push({
      project,
      title: test.titlePath().slice(2).join(' › '),
      status: result.status,
      ms: result.duration,
      timeoutMs: test.timeout,
      latencies,
      findings: invariants ? (JSON.parse(invariants) as { findings: number }).findings : null,
      blocked: result.status !== 'passed' && result.status !== 'skipped' && result.errors.some((e) => isInfraBlocked(e.message)),
    });
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    const group = process.env.E2E_GROUP;
    const blocked = this.rows.filter((r) => r.blocked);
    const failed = this.rows.filter((r) => !r.blocked && (r.status === 'failed' || r.status === 'timedOut'));
    const shardProblem = emptyShardProblem(group, this.plannedJourneys);
    if (blocked.length > 0) {
      mkdirSync(this.outputDir, { recursive: true });
      writeFileSync(join(this.outputDir, 'blocked.json'), JSON.stringify(blocked, null, 2));
    }
    const verdict =
      failed.length > 0 ? 'FAILED'
        : shardProblem ? `FAILED: ${shardProblem}`
          : blocked.length > 0 ? 'BLOCKED (infra), not a product verdict'
            : result.status === 'passed' ? 'PASSED' : result.status.toUpperCase();
    let build = 'no stack';
    const statePath = process.env.STACK_STATE;
    if (statePath && existsSync(statePath)) {
      const { expected } = JSON.parse(readFileSync(statePath, 'utf8')) as { expected: { commit: string; bundleHash: string } };
      build = `\`${expected.commit.slice(0, 12)}:${expected.bundleHash.slice(0, 12)}\``;
    }
    const engines = [...new Set(this.browsers.values())].join(', ') || 'no browser';
    const shard = group ? ` · group ${group}` : '';
    // Journeys that ran on a live stack: the selftests time fixture pages and prove a budget can fail.
    const ran = this.rows.filter((r) => r.status !== 'skipped' && !r.blocked && isJourneyProject(r.project));
    const durations = latencyRows(ran.map((r) => ({ project: r.project, name: r.title, ms: r.ms, budgetMs: r.timeoutMs || null })));
    const lines = [
      `### e2e: ${verdict}`,
      '',
      `${build} · ${engines}${shard} · ${process.platform} ${process.arch} · ${this.rows.length} tests, ${failed.length} failed, ${blocked.length} blocked`,
      '',
      '| Project | Test | Status | Time | Latencies | Invariant findings |',
      '|---|---|---|---|---|---|',
      ...this.rows.map((r) =>
        `| ${r.project} | ${r.title.replace(/\|/g, '\\|')} | ${r.blocked ? 'BLOCKED' : r.status} | ${seconds(r.ms)}${r.ms > SLOW_MS ? ' (slow)' : ''} | ${r.latencies.map((l) => `${l.name} ${l.ms} ms${l.budgetMs ? ` / ${l.budgetMs}` : ''}`).join('; ')} | ${r.findings ?? ''} |`,
      ),
      '',
      ...percentileTable('Latency percentiles', 'Latency', latencyRows(ran.flatMap((r) => r.latencies)), millis),
      // Durations matter once a test repeats (repeat_each > 1): they size shards against the 13-minute budget.
      ...(durations.some((d) => d.n > 1) ? percentileTable('Journey durations (budget: the test timeout)', 'Test', durations, seconds) : []),
    ];
    const text = `${lines.join('\n')}\n`;
    mkdirSync(this.outputDir, { recursive: true });
    writeFileSync(join(this.outputDir, 'summary.md'), text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    if (shardProblem) {
      console.error(`e2e: ${shardProblem}`);
      return { status: 'failed' };
    }
    return undefined;
  }
}
