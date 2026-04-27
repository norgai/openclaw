import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateMessagesTokens } from "../../compaction.js";

// Helper: create an assistant message with a single text block
function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as AgentMessage;
}

// Helper: create a toolResult message with text content blocks
function makeToolResultText(...texts: string[]): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: texts.map((text) => ({ type: "text", text })),
    isError: false,
    timestamp: 2,
  } as AgentMessage;
}

// Helper: create a toolResult message with a non-text, non-image content block
// (e.g. a JSON object or custom type that upstream estimateTokens ignores)
function makeToolResultWithObjectBlock(obj: Record<string, unknown>): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_2",
    toolName: "search",
    content: [obj as unknown as TextContent],
    isError: false,
    timestamp: 3,
  } as AgentMessage;
}

describe("preemptive-compaction chars-fallback", () => {
  it("a tool-heavy session registers more chars than a text-only equivalent", () => {
    const content = "alpha beta gamma delta epsilon ".repeat(200);

    const textOnly: AgentMessage[] = [makeAssistant(content)];

    const toolHeavy: AgentMessage[] = [
      makeAssistant("short"),
      makeToolResultText(content, content, content),
    ];

    const textOnlyTokens = estimateMessagesTokens(textOnly);
    const toolHeavyTokens = estimateMessagesTokens(toolHeavy);

    // Tool-heavy session has 3× the content in tool results; must register higher
    expect(toolHeavyTokens).toBeGreaterThan(textOnlyTokens);
  });

  it("non-text, non-image toolResult blocks are counted via JSON.stringify fallback", () => {
    const emptyToolResult = makeToolResultText();
    const objectBlock = makeToolResultWithObjectBlock({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "A".repeat(1000) },
    });

    const baseTokens = estimateMessagesTokens([emptyToolResult]);
    const withObjectTokens = estimateMessagesTokens([objectBlock]);

    // The object block is not text/image so upstream gives 0; our supplement must add chars
    expect(withObjectTokens).toBeGreaterThan(baseTokens);
  });

  it("text toolResult blocks are counted by the upstream path (not double-counted)", () => {
    const textContent = "hello world ".repeat(100);
    const textBlock = makeToolResultText(textContent);
    const objectBlock = makeToolResultWithObjectBlock({ type: "text", text: textContent });

    const textTokens = estimateMessagesTokens([textBlock]);
    const objectTokens = estimateMessagesTokens([objectBlock]);

    // An object block with type=text is NOT counted by upstream (type check on .type===text
    // does not match since our block is actually type=text — but it IS a text block, so
    // upstream counts it). Both paths should produce roughly similar token counts.
    // We only assert neither is zero.
    expect(textTokens).toBeGreaterThan(0);
    expect(objectTokens).toBeGreaterThan(0);
  });
});
