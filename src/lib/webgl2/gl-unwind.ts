// Ordered-construction bookkeeping for multi-step GL allocation.
//
// WebGL has no RAII: a builder that creates a program, then a texture, then a
// framebuffer and throws on the third leaves the first two allocated with no
// handle left to free them. `createGlUnwindStack` records a release step beside
// every value as it is created, and `unwind()` runs those steps newest-first.
//
// It is the expression-oriented twin of `buildInOrder` in `engine-resources.ts`:
// `track` hands the value straight back, so an `async` builder can `await`
// between steps without splitting each one into its own closure.

/** Registered release steps, newest last. */
export interface GlUnwindStack {
  /** Registers `release(value)` as the undo step and returns `value` unchanged. */
  track<T>(value: T, release: (value: T) => void): T;
  /**
   * Releases every tracked value, newest first. Idempotent: the steps are taken
   * off the stack as they run, so a second call (a `catch` that unwinds and a
   * `finally` that unwinds again) is a no-op rather than a double delete.
   */
  unwind(): void;
}

/**
 * Creates an empty unwind stack. The step list is private to the closure.
 *
 * Every step runs inside its own `try`/`catch`, so one failing release cannot
 * strand the resources registered before it — the remaining steps still run.
 * The collected failures are reported through `console.error` and deliberately
 * **not** rethrown: `unwind()` is called from a `catch` block that is about to
 * rethrow the real cause, and throwing here would replace that cause with a
 * secondary cleanup error. Cleanup is best-effort by construction.
 */
export function createGlUnwindStack(): GlUnwindStack {
  // Encapsulated mutable state: the pending release steps. Nothing outside this
  // closure can observe or reorder them.
  const steps: (() => void)[] = [];
  return Object.freeze({
    track<T>(value: T, release: (value: T) => void): T {
      steps.push(() => release(value));
      return value;
    },
    unwind(): void {
      const failures: unknown[] = [];
      // `pop()` rather than an index walk: the step is off the stack before it
      // runs, which is what makes a second `unwind()` a no-op.
      for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
        try {
          step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 0) return;
      const detail = failures.map((error) => (error instanceof Error ? error.message : String(error))).join("；");
      console.error(`GL 资源回卷时有 ${failures.length} 个释放步骤失败（已继续释放其余资源）：${detail}`);
    },
  });
}
