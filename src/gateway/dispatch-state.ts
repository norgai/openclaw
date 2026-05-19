import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/dispatch");

/**
 * Manages per-connection dispatch state for bundle-invalidated reload gating.
 *
 * Tracks active job counts and queued idle callbacks keyed by `connId`.
 * The `cleanupConnId` method must be called when a WS connection closes to
 * prevent a slow memory leak in long-running gateway processes with high
 * connection churn.
 */
export type DispatchStateManager = {
  markDispatchStarted: (connId: string) => void;
  markDispatchEnded: (connId: string) => void;
  onDispatchIdle: (connId: string, callback: () => void) => void;
  /** Drop all state for a closed connection. Any queued idle callbacks are
   * discarded (not invoked) — the connection is gone and the reload would
   * target nothing. */
  cleanupConnId: (connId: string) => void;
};

export function createDispatchStateManager(): DispatchStateManager {
  const activeCounts = new Map<string, number>();
  const idleCallbacks = new Map<string, Array<() => void>>();

  return {
    markDispatchStarted(connId) {
      activeCounts.set(connId, (activeCounts.get(connId) ?? 0) + 1);
    },

    markDispatchEnded(connId) {
      const prev = activeCounts.get(connId) ?? 0;
      const next = Math.max(0, prev - 1);
      if (next === 0) {
        activeCounts.delete(connId);
        const callbacks = idleCallbacks.get(connId);
        if (callbacks) {
          idleCallbacks.delete(connId);
          for (const cb of callbacks) {
            try {
              cb();
            } catch {
              /* best-effort */
            }
          }
        }
      } else {
        activeCounts.set(connId, next);
      }
    },

    onDispatchIdle(connId, callback) {
      if ((activeCounts.get(connId) ?? 0) === 0) {
        // Already idle — call inline (non-blocking; caller must not rely on
        // it being async).
        try {
          callback();
        } catch {
          /* best-effort */
        }
      } else {
        const existing = idleCallbacks.get(connId) ?? [];
        existing.push(callback);
        idleCallbacks.set(connId, existing);
      }
    },

    cleanupConnId(connId) {
      activeCounts.delete(connId);
      const pending = idleCallbacks.get(connId);
      if (pending?.length) {
        idleCallbacks.delete(connId);
        log.debug("dispatch_idle_callbacks_dropped", { connId, count: pending.length });
      }
    },
  };
}
