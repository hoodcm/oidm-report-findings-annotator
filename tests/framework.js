/**
 * Minimal browser-based test framework. No dependencies.
 *
 * Usage:
 *   describe('group name', () => {
 *     it('does the thing', () => {
 *       assert(actual === expected, 'message on failure');
 *       assertEqual(actual, expected);
 *       assertDeepEqual(actual, expected);
 *       assertThrows(() => fnThatShouldThrow());
 *     });
 *   });
 *
 * Then call: await runTests() and read window.__testResults.
 */

const __suites = [];
let __currentSuite = null;

function describe(name, fn) {
  const suite = { name, tests: [] };
  __suites.push(suite);
  __currentSuite = suite;
  try { fn(); } finally { __currentSuite = null; }
}

function it(name, fn) {
  if (!__currentSuite) throw new Error('it() called outside describe()');
  __currentSuite.tests.push({ name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      (msg ? msg + ': ' : '') +
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      (msg ? msg + ': ' : '') +
      `\n  expected: ${e}\n  got:      ${a}`
    );
  }
}

function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(msg || 'Expected function to throw');
}

function assertIncludes(haystack, needle, msg) {
  if (!haystack || !haystack.includes(needle)) {
    throw new Error(
      (msg ? msg + ': ' : '') +
      `expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`
    );
  }
}

async function runTests() {
  const results = { suites: [], passed: 0, failed: 0, total: 0 };
  for (const suite of __suites) {
    const sr = { name: suite.name, tests: [], passed: 0, failed: 0 };
    for (const t of suite.tests) {
      results.total++;
      try {
        await t.fn();
        sr.tests.push({ name: t.name, passed: true });
        sr.passed++;
        results.passed++;
      } catch (e) {
        sr.tests.push({ name: t.name, passed: false, error: e.message || String(e) });
        sr.failed++;
        results.failed++;
      }
    }
    results.suites.push(sr);
  }
  window.__testResults = results;
  return results;
}

window.describe = describe;
window.it = it;
window.assert = assert;
window.assertEqual = assertEqual;
window.assertDeepEqual = assertDeepEqual;
window.assertThrows = assertThrows;
window.assertIncludes = assertIncludes;
window.runTests = runTests;
