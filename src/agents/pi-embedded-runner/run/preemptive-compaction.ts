import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { SAFETY_MARGIN } from "../../compaction.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

export type PreemptiveCompactionRoute =
  | "fits"
  | "compact_only"
  | "truncate_tool_results_only"
  | "compact_then_truncate";

/**
 * Indicates whether the token estimate came from the native estimator or the
 * chars/4 heuristic fallback (used when estimateTokens is unavailable for the
 * current model, e.g. manifest/auto proxy-router sessions).
 */
export type PreemptiveTokenSource = "estimator" | "charsHeuristic";

// ─── chars/4 fallback for proxy/router models (e.g. manifest/auto) ────────────
// estimateTokens() from @mariozechner/pi-coding-agent may throw or return an
// unusable value for messages produced by proxy/router models that have no
// native tokenizer mapping.  When that happens the preemptive check silently
// sees 0 estimated tokens and never fires — causing repeated reactive overflows
// on long-lived sessions (NOR-2016).
//
// Fix: if estimateTokens throws or returns ≤0, fall back to floor(chars/4).
// The fallback is conservative (slightly over-estimates, matching the
// ESTIMATED_CHARS_PER_TOKEN constant already used in this file).

function getAgentMessageChars(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      total += text.length;
    }
  }
  return total;
}

function estimateTokensRobust(msg: AgentMessage): {
  tokens: number;
  heuristic: boolean;
} {
  try {
    const t = estimateTokens(msg);
    if (typeof t === "number" && Number.isFinite(t) && t > 0) {
      return { tokens: t, heuristic: false };
    }
  } catch {
    // estimateTokens unavailable for this message shape — fall through.
  }
  return {
    tokens: Math.floor(getAgentMessageChars(msg) / ESTIMATED_CHARS_PER_TOKEN),
    heuristic: true,
  };
}

function estimateMessagesRobust(messages: AgentMessage[]): {
  tokens: number;
  tokenSource: PreemptiveTokenSource;
} {
  let total = 0;
  let anyHeuristic = false;
  for (const msg of messages) {
    const result = estimateTokensRobust(msg);
    total += result.tokens;
    if (result.heuristic) {
      anyHeuristic = true;
    }
  }
  return {
    tokens: total,
    tokenSource: anyHeuristic ? "charsHeuristic" : "estimator",
  };
}

// ──────────────────────────────────────────────────────────────────────────────

function estimatePrePromptTokensFull(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): { tokens: number; tokenSource: PreemptiveTokenSource } {
  const { messages, systemPrompt, prompt } = params;
  const syntheticMessages: AgentMessage[] = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
    syntheticMessages.push({
      role: "system",
      content: systemPrompt,
      timestamp: 0,
    } as unknown as AgentMessage);
  }
  syntheticMessages.push({ role: "user", content: prompt, timestamp: 0 } as AgentMessage);

  const historyResult = estimateMessagesRobust(messages);
  const syntheticResult = estimateMessagesRobust(syntheticMessages);
  const tokenSource: PreemptiveTokenSource =
    historyResult.tokenSource === "charsHeuristic" ||
    syntheticResult.tokenSource === "charsHeuristic"
      ? "charsHeuristic"
      : "estimator";

  return {
    tokens: Math.max(0, Math.ceil((historyResult.tokens + syntheticResult.tokens) * SAFETY_MARGIN)),
    tokenSource,
  };
}

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  return estimatePrePromptTokensFull(params).tokens;
}

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
}): {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  tokenSource: PreemptiveTokenSource;
} {
  const { tokens: estimatedPromptTokens, tokenSource } = estimatePrePromptTokensFull(params);
  const promptBudgetBeforeReserve = Math.max(
    1,
    Math.floor(params.contextTokenBudget) - Math.max(0, Math.floor(params.reserveTokens)),
  );
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: params.messages,
    contextWindowTokens: params.contextTokenBudget,
  });
  const overflowChars = overflowTokens * ESTIMATED_CHARS_PER_TOKEN;
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars + truncationBufferChars,
    Math.ceil(overflowChars * 1.5),
  );
  const toolResultReducibleChars = toolResultPotential.maxReducibleChars;

  let route: PreemptiveCompactionRoute = "fits";
  if (overflowTokens > 0) {
    if (toolResultReducibleChars <= 0) {
      route = "compact_only";
    } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
      route = "truncate_tool_results_only";
    } else {
      route = "compact_then_truncate";
    }
  }
  return {
    route,
    shouldCompact: route === "compact_only" || route === "compact_then_truncate",
    estimatedPromptTokens,
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
    tokenSource,
  };
}
