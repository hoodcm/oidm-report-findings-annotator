/**
 * Pure ring-buffer op for the snapshot undo stack (plan D5): one mechanism
 * covers every accidental edit — _saveCurrentReport pushes the report's
 * prior serialized state before each write, capped at DEPTH (oldest
 * dropped). Kept as a standalone pure module so the cap contract is
 * unit-testable (js/app.js only runs in a browser).
 */

const UndoRing = {
  DEPTH: 20,

  // Push `state` onto `stack`, dropping the oldest entry past DEPTH.
  // Mutates and returns the stack.
  push(stack, state) {
    stack.push(state);
    if (stack.length > this.DEPTH) stack.shift();
    return stack;
  },
};

window.UndoRing = UndoRing;
