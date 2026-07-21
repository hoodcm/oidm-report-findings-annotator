// Playwright config for the OIDM annotator E2E suite.
// Runs the static SPA via `python3 serve.py` (no-cache headers, so stale
// browser caches never mask a JS/CSS change under test).
// Tests target a single Chromium worker to avoid shared IndexedDB races.
//
// Why a single worker? Each spec's setup writes to IndexedDB on
// http://localhost:8501 — workers share the same origin and therefore the
// same IndexedDB store. Parallel workers would interleave seeds and produce
// flaky tests for no meaningful speedup at this corpus size.
//
// Browser: locally we drive the already-installed Chrome for Testing binary
// (no `playwright install` of a separate Chromium). CI keeps Playwright's own
// browser install, so `executablePath` is only injected when CI is unset.

const fs = require('fs');
const path = require('path');

// Resolve the newest installed Chrome for Testing binary. Returns null if none
// is present (or on a non-arm layout) so we fall back to Playwright's bundled
// browser rather than crash the whole run.
function chromeForTestingPath() {
  const base = path.join(process.env.HOME || '', '.chrome-for-testing', 'chrome');
  let versionDir;
  try {
    versionDir = fs.readdirSync(base).sort().pop();
  } catch {
    return null;
  }
  if (!versionDir) return null;
  const bin = path.join(
    base, versionDir, 'chrome-mac-arm64',
    'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'
  );
  return fs.existsSync(bin) ? bin : null;
}

const cft = process.env.CI ? null : chromeForTestingPath();

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
    ...(cft ? { launchOptions: { executablePath: cft } } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
};
