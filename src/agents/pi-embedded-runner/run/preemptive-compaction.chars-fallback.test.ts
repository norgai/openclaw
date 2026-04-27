import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  shouldPreemptivelyCompactBeforePrompt,
  estimatePrePromptTokens,
} from "./preemptive-compaction.js";

// ─── Mock setup ─────────────────────────────────────────────────────────────
// Intercept estimateTokens so we can simulate proxy/router models (manifest/auto)
// that have no native tokenizer mapping and throw on every call.

const piCodingAgentMocks = vi.hoisted(() => ({
  estimateTokens: vi.fn((_message: unknown): number => {
    throw new Error("estimateTokens: unsupported model for proxy/router");
  }),
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    estimateTokens: piCodingAgentMocks.estimateTokens,
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

let ts = 1;
function makeMsg(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: ts++ } as AgentMessage;
}

function makeLongHistory(charCount: number): AgentMessage[] {
  // Split into realistic message sizes (~400 chars each)
  const msgs: AgentMessage[] = [];
  const chunkSize = 400;
  let remaining = charCount;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    msgs.push(makeMsg("x".repeat(size)));
    remaining -= size;
  }
  return msgs;
}

// ─── Tests: chars/4 heuristic (estimateTokens always throws) ─────────────────

describe("preemptive-compaction: chars/4 heuristic fallback (NOR-2016)", () => {
  // Default mock already throws — no extra setup needed.

  afterEach(() => {
    vi.clearAllMocks();
    piCodingAgentMocks.estimateTokens.mockImplementation((_: unknown): number => {
      throw new Error("estimateTokens: unsupported model for proxy/router");
    });
  });

  it("MUST FAIL PRE-FIX: proactive compaction fires when chars/4 estimate exceeds budget", () => {
    // 90 messages × ~400 chars = ~36 000 chars → ~9 000 tokens via chars/4
    // Budget: 8 000 tokens → should overflow → shouldCompact = true
    const messages = makeLongHistory(36_000);

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "You are a helpful assistant.",
      prompt: "What is my current status?",
      contextTokenBudget: 8_000,
      reserveTokens: 500,
    });

    expect(result.tokenSource).toBe("charsHeuristic");
    expect(result.estimatedPromptTokens).toBeGreaterThan(0);
    expect(result.shouldCompact).toBe(true);
    expect(result.overflowTokens).toBeGreaterThan(0);
  });

  it("does not trigger compaction when chars/4 estimate fits within budget", () => {
    // Small history: 200 chars → 50 tokens via chars/4. Budget: 10 000.
    const messages = [makeMsg("x".repeat(200))];

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hi",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

    expect(result.tokenSource).toBe("charsHeuristic");
    expect(result.route).toBe("fits");
    expect(result.shouldCompact).toBe(false);
  });

  it("tokenSource is charsHeuristic when estimateTokens throws for all messages", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeMsg("some content")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 100_000,
      reserveTokens: 1_000,
    });

    expect(result.tokenSource).toBe("charsHeuristic");
  });

  it("estimatePrePromptTokens returns non-zero value via chars/4 even when estimateTokens throws", () => {
    const messages = [makeMsg("x".repeat(4_000))]; // 4 000 chars → 1 000 tokens heuristic
    const estimated = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });

    // Should be > 0 (heuristic fired).  Allow SAFETY_MARGIN headroom.
    expect(estimated).toBeGreaterThan(0);
    // 1000 tokens * 1.2 safety margin ≈ 1200
    expect(estimated).toBeGreaterThanOrEqual(1_000);
  });

  it("correctly routes to compact_only when chars/4 shows overflow and no tool results", () => {
    // Long pure-text history with no tool results → compact_only path
    const messages = makeLongHistory(50_000); // ~12 500 tokens heuristic

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "assistant context",
      prompt: "next task",
      contextTokenBudget: 10_000,
      reserveTokens: 500,
    });

    expect(result.tokenSource).toBe("charsHeuristic");
    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
  });
});

// ─── Tests: real estimator path (tokenSource=estimator) ──────────────────────

describe("preemptive-compaction: estimator path still works when estimateTokens succeeds", () => {
  beforeEach(() => {
    // Override mock to return a real positive number
    piCodingAgentMocks.estimateTokens.mockImplementation((_: unknown): number => 1);
  });

  afterEach(() => {
    piCodingAgentMocks.estimateTokens.mockImplementation((_: unknown): number => {
      throw new Error("estimateTokens: unsupported model for proxy/router");
    });
  });

  it("tokenSource is estimator when estimateTokens succeeds", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeMsg("short")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

    expect(result.tokenSource).toBe("estimator");
    expect(result.route).toBe("fits");
  });
});
