import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearBundleRevisionCacheForTest,
  checkAndReloadBundleRevision,
} from "./bundle-revision.js";

// Module-level mocks
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ agents: {} })),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => undefined as string | undefined),
}));

const mockFetch = vi.fn<typeof fetch>();

// Store original env
const originalEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function makeBundleResponse(
  overrides: Partial<{
    bundleRevisionId: string;
    text: string;
    entryFile: string;
    bundleAssembledAt: string;
    manifest: unknown;
    warnings: unknown[];
  }> = {},
): Record<string, unknown> {
  return {
    bundleRevisionId: "rev-abc123",
    text: "# AGENTS.md\nSystem instructions.",
    entryFile: "AGENTS.md",
    bundleAssembledAt: "2026-05-15T00:00:00.000Z",
    manifest: [],
    warnings: [],
    ...overrides,
  };
}

function mockSuccessFetch(body: Record<string, unknown> = makeBundleResponse()) {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockFailFetch(status = 500) {
  mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status }));
}

function mockNetworkError() {
  mockFetch.mockRejectedValueOnce(new Error("network error"));
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  // Make retries instantaneous in tests
  vi.stubGlobal("setTimeout", (fn: () => void) => {
    fn();
    return 0;
  });
  _clearBundleRevisionCacheForTest();
  // Save and set env vars
  for (const k of [
    "PAPERCLIP_API_URL",
    "PAPERCLIP_API_KEY",
    "CF_ACCESS_CLIENT_ID",
    "CF_ACCESS_CLIENT_SECRET",
  ]) {
    originalEnv[k] = process.env[k];
  }
  setEnv({
    PAPERCLIP_API_URL: "https://paperclip.example.com",
    PAPERCLIP_API_KEY: "pcp_test_key",
    CF_ACCESS_CLIENT_ID: undefined,
    CF_ACCESS_CLIENT_SECRET: undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  // Restore env
  setEnv(originalEnv);
});

describe("checkAndReloadBundleRevision", () => {
  describe("AC1: skip when bundleRevisionId is absent", () => {
    it("returns skip when bundleRevisionId is null", async () => {
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-agent1",
        agentId: "agent1",
        bundleRevisionId: null,
      });
      expect(result.status).toBe("skip");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns skip when bundleRevisionId is undefined", async () => {
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-agent1",
        agentId: "agent1",
        bundleRevisionId: undefined,
      });
      expect(result.status).toBe("skip");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("AC2: match when cached revision equals incoming", () => {
    it("returns match on second call with same revision", async () => {
      mockSuccessFetch();
      // First call: cache miss → fetches
      const first = await checkAndReloadBundleRevision({
        sessionKey: "sk-agent2",
        agentId: "agent2",
        bundleRevisionId: "rev-abc123",
      });
      expect(first.status).toBe("refreshed");

      // Second call with same revision → cache hit
      const second = await checkAndReloadBundleRevision({
        sessionKey: "sk-agent2",
        agentId: "agent2",
        bundleRevisionId: "rev-abc123",
      });
      expect(second.status).toBe("match");
      // Fetch called only once (during the first call)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("AC3: fetch on cache miss", () => {
    it("fetches bundle on first call (cold start)", async () => {
      mockSuccessFetch();
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-agent3",
        agentId: "agent3",
        bundleRevisionId: "rev-xyz",
      });
      expect(result.status).toBe("refreshed");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain("/api/agents/agent3/bundle");
    });

    it("fetches bundle on revision mismatch", async () => {
      // Seed cache with old revision
      mockSuccessFetch(makeBundleResponse({ bundleRevisionId: "rev-old" }));
      await checkAndReloadBundleRevision({
        sessionKey: "sk-agent3",
        agentId: "agent3",
        bundleRevisionId: "rev-old",
      });

      // Now send a new revision → should fetch again
      mockSuccessFetch(makeBundleResponse({ bundleRevisionId: "rev-new" }));
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-agent3",
        agentId: "agent3",
        bundleRevisionId: "rev-new",
      });
      expect(result.status).toBe("refreshed");
      if (result.status === "refreshed") {
        expect(result.bundleRevisionId).toBe("rev-new");
      }
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("AC4: CF Access headers", () => {
    it("includes CF-Access headers when env vars are set", async () => {
      setEnv({
        CF_ACCESS_CLIENT_ID: "test-cf-id.access",
        CF_ACCESS_CLIENT_SECRET: "test-cf-secret",
      });
      mockSuccessFetch();
      await checkAndReloadBundleRevision({
        sessionKey: "sk-cf",
        agentId: "agent-cf",
        bundleRevisionId: "rev-cf",
      });
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["CF-Access-Client-Id"]).toBe("test-cf-id.access");
      expect(headers["CF-Access-Client-Secret"]).toBe("test-cf-secret");
    });

    it("omits CF-Access headers when env vars are absent", async () => {
      mockSuccessFetch();
      await checkAndReloadBundleRevision({
        sessionKey: "sk-nocf",
        agentId: "agent-nocf",
        bundleRevisionId: "rev-nocf",
      });
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["CF-Access-Client-Id"]).toBeUndefined();
      expect(headers["CF-Access-Client-Secret"]).toBeUndefined();
    });
  });

  describe("AC5: returns unavailable when env vars missing", () => {
    it("returns unavailable when PAPERCLIP_API_URL is not set", async () => {
      setEnv({ PAPERCLIP_API_URL: undefined });
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-nourl",
        agentId: "agent1",
        bundleRevisionId: "rev-1",
      });
      expect(result.status).toBe("unavailable");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns unavailable when PAPERCLIP_API_KEY is not set", async () => {
      setEnv({ PAPERCLIP_API_KEY: undefined });
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-nokey",
        agentId: "agent1",
        bundleRevisionId: "rev-1",
      });
      expect(result.status).toBe("unavailable");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("AC6: retry on transient failure", () => {
    it("retries up to 3 times and returns unavailable after exhaustion", async () => {
      // 4 failures: initial + 3 retries (setTimeout is stubbed to be immediate in beforeEach)
      mockFailFetch(502);
      mockFailFetch(502);
      mockFailFetch(502);
      mockFailFetch(502);

      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-retry",
        agentId: "agent-retry",
        bundleRevisionId: "rev-r",
      });
      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.error).toContain("502");
      }
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("succeeds on a later retry", async () => {
      mockFailFetch(503);
      mockFailFetch(503);
      mockSuccessFetch();

      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-retryok",
        agentId: "agent-retryok",
        bundleRevisionId: "rev-rk",
      });
      expect(result.status).toBe("refreshed");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("AC7: network error is retried", () => {
    it("treats network errors as transient and retries", async () => {
      mockNetworkError();
      mockNetworkError();
      mockSuccessFetch();

      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-net",
        agentId: "agent-net",
        bundleRevisionId: "rev-net",
      });
      expect(result.status).toBe("refreshed");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("AC8: writes bundle text to workspace on refresh", () => {
    it("writes AGENTS.md to workspace dir on successful bundle fetch", async () => {
      const { resolveAgentWorkspaceDir } = await vi.importMock<
        typeof import("../agents/agent-scope.js")
      >("../agents/agent-scope.js");

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-revision-test-"));
      vi.mocked(resolveAgentWorkspaceDir).mockReturnValue(tempDir);

      mockSuccessFetch(
        makeBundleResponse({ text: "# Instructions\nHello!", entryFile: "AGENTS.md" }),
      );

      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-write",
        agentId: "agent-write",
        bundleRevisionId: "rev-write",
      });
      expect(result.status).toBe("refreshed");

      const written = await fs.readFile(path.join(tempDir, "AGENTS.md"), "utf-8");
      expect(written).toBe("# Instructions\nHello!");

      await fs.rm(tempDir, { recursive: true });
    });

    it("respects custom entryFile name from bundle response", async () => {
      const { resolveAgentWorkspaceDir } = await vi.importMock<
        typeof import("../agents/agent-scope.js")
      >("../agents/agent-scope.js");

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-revision-test-custom-"));
      vi.mocked(resolveAgentWorkspaceDir).mockReturnValue(tempDir);

      mockSuccessFetch(
        makeBundleResponse({ entryFile: "CLAUDE.md", text: "# Claude instructions" }),
      );

      await checkAndReloadBundleRevision({
        sessionKey: "sk-custom",
        agentId: "agent-custom",
        bundleRevisionId: "rev-custom",
      });

      const written = await fs.readFile(path.join(tempDir, "CLAUDE.md"), "utf-8");
      expect(written).toBe("# Claude instructions");

      await fs.rm(tempDir, { recursive: true });
    });

    it("does not throw when workspaceDir is undefined", async () => {
      const { resolveAgentWorkspaceDir } = await vi.importMock<
        typeof import("../agents/agent-scope.js")
      >("../agents/agent-scope.js");
      vi.mocked(resolveAgentWorkspaceDir).mockReturnValue(undefined as unknown as string);

      mockSuccessFetch();

      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-nodir",
        agentId: "agent-nodir",
        bundleRevisionId: "rev-nodir",
      });
      expect(result.status).toBe("refreshed");
    });
  });

  describe("AC9: cache is updated after successful refresh", () => {
    it("caches the server revision (not the incoming revision)", async () => {
      // Server returns a different revision than what was sent
      mockSuccessFetch(makeBundleResponse({ bundleRevisionId: "rev-server" }));
      const first = await checkAndReloadBundleRevision({
        sessionKey: "sk-cache",
        agentId: "agent-cache",
        bundleRevisionId: "rev-client",
      });
      expect(first.status).toBe("refreshed");

      // Same session key, now with server revision → should match without fetching
      const second = await checkAndReloadBundleRevision({
        sessionKey: "sk-cache",
        agentId: "agent-cache",
        bundleRevisionId: "rev-server",
      });
      expect(second.status).toBe("match");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("AC10: cache is session-scoped", () => {
    it("caches independently per sessionKey", async () => {
      mockSuccessFetch(makeBundleResponse({ bundleRevisionId: "rev-abc" }));
      mockSuccessFetch(makeBundleResponse({ bundleRevisionId: "rev-abc" }));

      // Two different session keys with same revision — each fetches independently
      await checkAndReloadBundleRevision({
        sessionKey: "sk-sess-a",
        agentId: "agent1",
        bundleRevisionId: "rev-abc",
      });
      await checkAndReloadBundleRevision({
        sessionKey: "sk-sess-b",
        agentId: "agent1",
        bundleRevisionId: "rev-abc",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Same session keys again → both match, no fetch
      const a2 = await checkAndReloadBundleRevision({
        sessionKey: "sk-sess-a",
        agentId: "agent1",
        bundleRevisionId: "rev-abc",
      });
      const b2 = await checkAndReloadBundleRevision({
        sessionKey: "sk-sess-b",
        agentId: "agent1",
        bundleRevisionId: "rev-abc",
      });
      expect(a2.status).toBe("match");
      expect(b2.status).toBe("match");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("AC11: build the correct bundle URL", () => {
    it("encodes agentId in the URL", async () => {
      mockSuccessFetch();
      await checkAndReloadBundleRevision({
        sessionKey: "sk-url",
        agentId: "agent-id-with-special",
        bundleRevisionId: "rev-url",
      });
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toBe("https://paperclip.example.com/api/agents/agent-id-with-special/bundle");
    });

    it("strips trailing slash from API URL", async () => {
      setEnv({ PAPERCLIP_API_URL: "https://paperclip.example.com/" });
      mockSuccessFetch();
      await checkAndReloadBundleRevision({
        sessionKey: "sk-slash",
        agentId: "agent1",
        bundleRevisionId: "rev-s",
      });
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toBe("https://paperclip.example.com/api/agents/agent1/bundle");
    });
  });

  describe("AC12: Authorization header is always sent", () => {
    it("sends Authorization: Bearer header", async () => {
      mockSuccessFetch();
      await checkAndReloadBundleRevision({
        sessionKey: "sk-auth",
        agentId: "agent1",
        bundleRevisionId: "rev-auth",
      });
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer pcp_test_key");
    });
  });

  describe("AC13: invalid bundle response shapes", () => {
    it("returns unavailable when bundleRevisionId is missing", async () => {
      // All 4 attempts return an invalid response (no bundleRevisionId)
      for (let i = 0; i < 4; i++) {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ text: "content" }), { status: 200 }),
        );
      }
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-invalid",
        agentId: "agent1",
        bundleRevisionId: "rev-1",
      });
      expect(result.status).toBe("unavailable");
    });

    it("returns unavailable when text is missing", async () => {
      for (let i = 0; i < 4; i++) {
        mockFetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ bundleRevisionId: "rev-1" }), { status: 200 }),
        );
      }
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-notext",
        agentId: "agent1",
        bundleRevisionId: "rev-1",
      });
      expect(result.status).toBe("unavailable");
    });

    it("returns unavailable when response is not JSON", async () => {
      for (let i = 0; i < 4; i++) {
        mockFetch.mockResolvedValueOnce(
          new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
        );
      }
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-badjson",
        agentId: "agent1",
        bundleRevisionId: "rev-1",
      });
      expect(result.status).toBe("unavailable");
    });
  });

  describe("AC14: write errors do not fail the check", () => {
    it("returns refreshed even when fs.writeFile throws", async () => {
      const { resolveAgentWorkspaceDir } = await vi.importMock<
        typeof import("../agents/agent-scope.js")
      >("../agents/agent-scope.js");
      vi.mocked(resolveAgentWorkspaceDir).mockReturnValue("/nonexistent-path-xyz");

      mockSuccessFetch();

      // writeFile will fail because the dir doesn't exist (mkdir may also fail)
      // but the result should still be "refreshed"
      const result = await checkAndReloadBundleRevision({
        sessionKey: "sk-writefail",
        agentId: "agent-writefail",
        bundleRevisionId: "rev-wf",
      });
      // Result is refreshed because write errors are swallowed
      expect(result.status).toBe("refreshed");
    });
  });
});
