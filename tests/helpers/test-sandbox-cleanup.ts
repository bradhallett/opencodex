/** Keep removal behind producer settlement and actual handle release, not a caller timeout. */
export function createTestSandboxCleanup(options: {
  drainProducers(): Promise<void>;
  waitForReaps(): Promise<void>;
  hasPendingReaps(): boolean;
  remove(): void;
}) {
  let complete = false;
  let drained = false;
  let running = false;
  let cleanup: Promise<void> | undefined;
  const remove = () => {
    if (complete) return;
    try {
      options.remove();
      complete = true;
    } catch {
      // A later run can reclaim the marked root; failure never grants stronger removal.
    }
  };
  return {
    afterAll(): Promise<void> {
      return cleanup ??= (async () => {
        running = true;
        try {
          await options.drainProducers();
          await options.waitForReaps();
          drained = true;
          if (!options.hasPendingReaps()) remove();
        } finally {
          running = false;
        }
      })();
    },
    onExit(): void {
      // Exit cannot await. Before the async barrier finishes, even a not-yet-registered
      // reaper may still be produced. Leave that root for ownership-checked stale recovery.
      if (!drained || running || options.hasPendingReaps()) return;
      remove();
    },
  };
}
