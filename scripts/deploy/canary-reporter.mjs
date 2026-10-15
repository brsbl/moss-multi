// The run log against a non-loopback target (e2e/playwright.config.ts; deploy-staging.yml's canary). That log is
// public, and a failed authenticated request's error carries Playwright's call log, cookie header included. So this
// prints each test's title, status and duration and withholds error text and test output; the JSON reporter keeps
// the detail on the runner, which nothing uploads.

/** @param {number} ms */
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

export default class CanaryReporter {
  /** @type {Map<string, number>} */
  counts = new Map();

  printsToStdio() {
    return true;
  }

  /**
   * @param {unknown} _config
   * @param {{ allTests(): unknown[] }} suite
   */
  onBegin(_config, suite) {
    console.log(`Running ${suite.allTests().length} tests; error text and test output are withheld off loopback.`);
  }

  /**
   * @param {{ titlePath(): string[] }} test
   * @param {{ status: string, duration: number }} result
   */
  onTestEnd(test, result) {
    this.counts.set(result.status, (this.counts.get(result.status) ?? 0) + 1);
    // titlePath: the root, the project, the file, describes and the test.
    console.log(`  ${result.status} ${test.titlePath().filter(Boolean).slice(1).join(' › ')} (${seconds(result.duration)})`);
  }

  onError() {
    console.error('A run-level error occurred; its text is withheld off loopback.');
  }

  /** @param {{ status: string, duration: number }} result */
  onEnd(result) {
    const counts = [...this.counts].map(([status, n]) => `${n} ${status}`).join(', ') || 'no tests';
    console.log(`${result.status}: ${counts} in ${seconds(result.duration)}`);
  }
}
