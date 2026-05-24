// Playwright config for OIDM annotator E2E.
// Runs the static SPA via `python3 serve.py` (no-cache headers).
// Tests target a single Chromium worker to avoid shared IndexedDB races.
//
// Why a single worker? Each spec's setup writes to IndexedDB on
// http://localhost:8501 — workers share the same origin and therefore the
// same IndexedDB store. Parallel workers would interleave seeds and produce
// flaky tests for no meaningful speedup at this corpus size.

module.exports = {
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  // Port 8502 isolates the test server from the manual dev server on 8501,
  // so a developer running `python3 serve.py` interactively while iterating
  // on the app doesn't collide with Playwright's webServer.
  webServer: {
    command: 'python3 tests/e2e/serve-test.py 8502',
    url: 'http://localhost:8502',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  use: {
    baseURL: 'http://localhost:8502',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
};
