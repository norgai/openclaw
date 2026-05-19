import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAgentStatusBeforeDispatch } from "./agent-status-check.js";

const mockFetch = vi.fn<typeof fetch>();

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

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
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
  setEnv(originalEnv);
});

function mockStatusResponse(status: string, httpStatus = 200) {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ status }), {
      status: httpStatus,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("checkAgentStatusBeforeDispatch", () => {
  // AC7 / AC13: API call with correct URL and Authorization header
  it("returns active for a non-paused agent", async () => {
    mockStatusResponse("active");
    const result = await checkAgentStatusBeforeDispatch("agent-abc");
    expect(result.status).toBe("active");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://paperclip.example.com/api/agents/agent-abc",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer pcp_test_key",
        }),
      }),
    );
  });

  // AC8: paused detection
  it("returns paused when agent status is paused", async () => {
    mockStatusResponse("paused");
    const result = await checkAgentStatusBeforeDispatch("agent-paused");
    expect(result.status).toBe("paused");
  });

  it("returns active for unknown non-paused statuses", async () => {
    mockStatusResponse("running");
    const result = await checkAgentStatusBeforeDispatch("agent-running");
    expect(result.status).toBe("active");
  });

  // AC13: fail-open on HTTP error
  it("returns unavailable on HTTP error response", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    const result = await checkAgentStatusBeforeDispatch("agent-xyz");
    expect(result.status).toBe("unavailable");
  });

  // AC13: fail-open on network failure
  it("returns unavailable on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));
    const result = await checkAgentStatusBeforeDispatch("agent-xyz");
    expect(result.status).toBe("unavailable");
    expect((result as { status: "unavailable"; reason: string }).reason).toContain("network error");
  });

  // AC13: fail-open when API not configured
  it("returns unavailable when PAPERCLIP_API_URL is missing", async () => {
    setEnv({ PAPERCLIP_API_URL: undefined });
    const result = await checkAgentStatusBeforeDispatch("agent-xyz");
    expect(result.status).toBe("unavailable");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns unavailable when PAPERCLIP_API_KEY is missing", async () => {
    setEnv({ PAPERCLIP_API_KEY: undefined });
    const result = await checkAgentStatusBeforeDispatch("agent-xyz");
    expect(result.status).toBe("unavailable");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns unavailable on invalid JSON response", async () => {
    mockFetch.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    const result = await checkAgentStatusBeforeDispatch("agent-xyz");
    expect(result.status).toBe("unavailable");
  });

  // CF Access headers forwarding
  it("includes CF Access headers when configured", async () => {
    setEnv({
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "cf-secret",
    });
    mockStatusResponse("active");
    await checkAgentStatusBeforeDispatch("agent-cf");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "cf-secret",
        }),
      }),
    );
  });

  // URL encoding
  it("URL-encodes agentId in request URL", async () => {
    mockStatusResponse("active");
    await checkAgentStatusBeforeDispatch("agent with spaces/and-slash");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://paperclip.example.com/api/agents/agent%20with%20spaces%2Fand-slash",
      expect.any(Object),
    );
  });

  // Trailing slash stripped from API URL
  it("strips trailing slash from PAPERCLIP_API_URL", async () => {
    setEnv({ PAPERCLIP_API_URL: "https://paperclip.example.com/" });
    mockStatusResponse("active");
    await checkAgentStatusBeforeDispatch("agent-abc");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://paperclip.example.com/api/agents/agent-abc",
      expect.any(Object),
    );
  });
});
