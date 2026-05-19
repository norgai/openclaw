import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  })),
}));

const { createDispatchStateManager } = await import("./dispatch-state.js");

describe("createDispatchStateManager", () => {
  let manager: ReturnType<typeof createDispatchStateManager>;

  beforeEach(() => {
    manager = createDispatchStateManager();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("markDispatchStarted / markDispatchEnded", () => {
    it("fires idle callbacks when active count drains to zero", () => {
      const connId = "conn-a";
      const cb = vi.fn();

      manager.markDispatchStarted(connId);
      manager.onDispatchIdle(connId, cb);
      expect(cb).not.toHaveBeenCalled();

      manager.markDispatchEnded(connId);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("does not fire callbacks until all dispatches end", () => {
      const connId = "conn-b";
      const cb = vi.fn();

      manager.markDispatchStarted(connId);
      manager.markDispatchStarted(connId);
      manager.onDispatchIdle(connId, cb);

      manager.markDispatchEnded(connId);
      expect(cb).not.toHaveBeenCalled();

      manager.markDispatchEnded(connId);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("calls onDispatchIdle callback inline when already idle", () => {
      const connId = "conn-c";
      const cb = vi.fn();

      // No markDispatchStarted — already idle
      manager.onDispatchIdle(connId, cb);
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("cleanupConnId — AC1, AC2, AC3", () => {
    it("AC1: cleans up active count for a mid-dispatch connection", () => {
      const connId = "conn-cleanup-active";

      manager.markDispatchStarted(connId);
      // Verify state is populated (side-effect: onDispatchIdle should queue)
      const queued = vi.fn();
      manager.onDispatchIdle(connId, queued);
      expect(queued).not.toHaveBeenCalled(); // still active

      // AC1: cleanup removes active count entry
      manager.cleanupConnId(connId);

      // After cleanup, onDispatchIdle should fire inline (count is 0)
      const afterClean = vi.fn();
      manager.onDispatchIdle(connId, afterClean);
      expect(afterClean).toHaveBeenCalledTimes(1);
    });

    it("AC2: queued idle callbacks are dropped, not invoked on cleanup", () => {
      const connId = "conn-cleanup-callbacks";
      const pendingCb = vi.fn();

      manager.markDispatchStarted(connId);
      manager.onDispatchIdle(connId, pendingCb);
      expect(pendingCb).not.toHaveBeenCalled();

      // AC2: cleanup drops pending callbacks without invoking them
      manager.cleanupConnId(connId);
      expect(pendingCb).not.toHaveBeenCalled();
    });

    it("AC3: both maps no longer contain connId after cleanup", () => {
      const connId = "conn-cleanup-maps";

      manager.markDispatchStarted(connId);
      manager.onDispatchIdle(connId, vi.fn());

      manager.cleanupConnId(connId);

      // After cleanup, dispatch should behave as idle (maps cleared)
      const postCleanCb = vi.fn();
      manager.onDispatchIdle(connId, postCleanCb);
      expect(postCleanCb).toHaveBeenCalledTimes(1); // fires inline = active count gone

      // markDispatchEnded on a cleaned-up connId should not throw
      expect(() => manager.markDispatchEnded(connId)).not.toThrow();
    });

    it("cleanupConnId is a no-op for a connId with no state", () => {
      expect(() => manager.cleanupConnId("conn-never-used")).not.toThrow();
    });

    it("cleanupConnId on an idle connection (no pending callbacks) does not throw", () => {
      const connId = "conn-idle-cleanup";
      // Start and fully drain a dispatch (no pending callbacks)
      manager.markDispatchStarted(connId);
      manager.markDispatchEnded(connId);

      expect(() => manager.cleanupConnId(connId)).not.toThrow();
    });

    it("multiple connIds are tracked independently; cleanup only removes target", () => {
      const connA = "conn-multi-a";
      const connB = "conn-multi-b";
      const cbA = vi.fn();
      const cbB = vi.fn();

      manager.markDispatchStarted(connA);
      manager.markDispatchStarted(connB);
      manager.onDispatchIdle(connA, cbA);
      manager.onDispatchIdle(connB, cbB);

      // Clean up connA only
      manager.cleanupConnId(connA);
      expect(cbA).not.toHaveBeenCalled(); // dropped

      // connB is unaffected — draining it should fire its callback
      manager.markDispatchEnded(connB);
      expect(cbB).toHaveBeenCalledTimes(1);
    });
  });
});
