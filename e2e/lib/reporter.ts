// The run summary (S-test §2.6): provenance, one row per test with latencies and invariant counts, slow tests,
// and BLOCKED (infra) kept apart from FAILED. Written to test-results/summary.md (in the CI artifact, which gh
// can download) and to $GITHUB_STEP_SUMMARY in CI.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { isInfraBlocked } from './infra.ts';

interface Row {
  project: string;
  title: string;
  status: string;
  ms: number;
  latencies: string[];
  findings: number | null;
  blocked: boolean;
}

const SLOW_MS = 90_000;

export default class MossReporter implements Reporter {
  private rows: Row[] = [];
  private browsers = new Map<string, string>();
  private outputDir = 'test-results';

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    this.outputDir = config.projects[0]?.outputDir ?? join(config.rootDir, 'test-results');
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? '';
    const annotations = result.annotations;
    const browser = annotations.find((a) => a.type === 'browser')?.description;
    if (browser && !this.browsers.has(project)) this.browsers.set(project, browser);
    const latencies = annotations.filter((a) => a.type === 'latency').map((a) => {
      const { name, ms, budgetMs } = JSON.parse(a.description ?? '{}') as { name: string; ms: number; budgetMs: number | null };
      return `${name} ${ms} ms${budgetMs ? ` / ${budgetMs}` : ''}`;
    });
    const invariants = annotations.find((a) => a.type === 'invariants')?.description;
    this.rows.push({
      project,
      title: test.titlePath().slice(2).join(' › '),
      status: result.status,
      ms: result.duration,
      latencies,
      findings: invariants ? (JSON.parse(invariants) as { findings: number }).findings : null,
      blocked: result.status !== 'passed' && result.status !== 'skipped' && result.errors.some((e) => isInfraBlocked(e.message)),
    });
  }

  onEnd(result: FullResult): void {
    const blocked = this.rows.filter((r) => r.blocked);
    const failed = this.rows.filter((r) => !r.blocked && (r.status === 'failed' || r.status === 'timedOut'));
    if (blocked.length > 0) {
      mkdirSync(this.outputDir, { recursive: true });
      writeFileSync(join(this.outputDir, 'blocked.json'), JSON.stringify(blocked, null, 2));
    }
    const verdict = failed.length > 0 ? 'FAILED' : blocked.length > 0 ? 'BLOCKED (infra), not a product verdict' : result.status === 'passed' ? 'PASSED' : result.status.toUpperCase();
    let build = 'no stack';
    const statePath = process.env.STACK_STATE;
    if (statePath && existsSync(statePath)) {
      const { expected } = JSON.parse(readFileSync(statePath, 'utf8')) as { expected: { commit: string; bundleHash: string } };
      build = `\`${expected.commit.slice(0, 12)}:${expected.bundleHash.slice(0, 12)}\``;
    }
    const engines = [...new Set(this.browsers.values())].join(', ') || 'no browser';
    const lines = [
      `### e2e: ${verdict}`,
      '',
      `${build} · ${engines} · ${process.platform} ${process.arch} · ${this.rows.length} tests, ${failed.length} failed, ${blocked.length} blocked`,
      '',
      '| Project | Test | Status | Time | Latencies | Invariant findings |',
      '|---|---|---|---|---|---|',
      ...this.rows.map((r) =>
        `| ${r.project} | ${r.title.replace(/\|/g, '\\|')} | ${r.blocked ? 'BLOCKED' : r.status} | ${(r.ms / 1000).toFixed(1)} s${r.ms > SLOW_MS ? ' (slow)' : ''} | ${r.latencies.join('; ')} | ${r.findings ?? ''} |`,
      ),
      '',
    ];
    const text = `${lines.join('\n')}\n`;
    mkdirSync(this.outputDir, { recursive: true });
    writeFileSync(join(this.outputDir, 'summary.md'), text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
}
