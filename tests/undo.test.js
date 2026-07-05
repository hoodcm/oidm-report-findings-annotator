/**
 * Tests for js/undo.js — the snapshot undo ring buffer (plan D5).
 * Contract: depth is capped at UndoRing.DEPTH (20); the oldest entry is
 * dropped, order is preserved, and the newest entry is always kept.
 */

describe('UndoRing — snapshot ring buffer', () => {
  it('21 pushes keep depth 20, dropping the oldest', () => {
    const stack = [];
    for (let i = 1; i <= 21; i++) UndoRing.push(stack, `state-${i}`);
    assertEqual(stack.length, 20);
    assertEqual(stack[0], 'state-2');            // state-1 dropped
    assertEqual(stack[stack.length - 1], 'state-21');
  });

  it('pushes below the cap keep every entry in order', () => {
    const stack = [];
    for (let i = 1; i <= 5; i++) UndoRing.push(stack, i);
    assertDeepEqual(stack, [1, 2, 3, 4, 5]);
  });

  it('mutates and returns the same stack (ring semantics, no reallocation)', () => {
    const stack = [];
    const out = UndoRing.push(stack, 'a');
    assert(out === stack);
  });
});
