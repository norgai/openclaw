import { describe, expect, it } from "vitest";
import { validateBundleInvalidatedControlFrame } from "../../protocol/index.js";

/**
 * AC2 — `agent_control` frame interception in `message-handler.ts` (~L1366-1412).
 *
 * The handler gates `agent_control` frames through AJV before invoking
 * `context.onDispatchIdle(connId, doReload)`. A malformed frame returns early
 * via the `!validateBundleInvalidatedControlFrame(parsed)` check and never
 * reaches the dispatch-idle path.
 *
 * These tests pin the validator contract so the gate behaves as documented:
 * valid frames pass; any deviation from the schema (missing field, wrong
 * literal, additional property, non-string id, non-integer ts) is rejected
 * before the handler reads `frame.action`.
 */
describe("validateBundleInvalidatedControlFrame (agent_control gate)", () => {
  const validFrame = {
    type: "agent_control" as const,
    action: "bundle_invalidated" as const,
    agentId: "agent-123",
    bundleRevisionId: "rev-abc",
    ts: 1_700_000_000_000,
  };

  it("accepts a well-formed bundle_invalidated frame", () => {
    expect(validateBundleInvalidatedControlFrame(validFrame)).toBe(true);
  });

  it("rejects frame with wrong type literal", () => {
    expect(validateBundleInvalidatedControlFrame({ ...validFrame, type: "req" })).toBe(false);
  });

  it("rejects frame with wrong action literal", () => {
    expect(validateBundleInvalidatedControlFrame({ ...validFrame, action: "other" })).toBe(false);
  });

  it("rejects frame missing agentId", () => {
    const { agentId, ...partial } = validFrame;
    void agentId;
    expect(validateBundleInvalidatedControlFrame(partial)).toBe(false);
  });

  it("rejects frame missing bundleRevisionId", () => {
    const { bundleRevisionId, ...partial } = validFrame;
    void bundleRevisionId;
    expect(validateBundleInvalidatedControlFrame(partial)).toBe(false);
  });

  it("rejects frame missing ts", () => {
    const { ts, ...partial } = validFrame;
    void ts;
    expect(validateBundleInvalidatedControlFrame(partial)).toBe(false);
  });

  it("rejects frame with empty agentId", () => {
    expect(validateBundleInvalidatedControlFrame({ ...validFrame, agentId: "" })).toBe(false);
  });

  it("rejects frame with empty bundleRevisionId", () => {
    expect(
      validateBundleInvalidatedControlFrame({
        ...validFrame,
        bundleRevisionId: "",
      }),
    ).toBe(false);
  });

  it("rejects frame with non-integer ts", () => {
    expect(validateBundleInvalidatedControlFrame({ ...validFrame, ts: 1.5 })).toBe(false);
  });

  it("rejects frame with negative ts", () => {
    expect(validateBundleInvalidatedControlFrame({ ...validFrame, ts: -1 })).toBe(false);
  });

  it("rejects frame with additional unknown property", () => {
    expect(
      validateBundleInvalidatedControlFrame({
        ...validFrame,
        extra: "nope",
      } as unknown),
    ).toBe(false);
  });

  it("rejects non-object payloads", () => {
    expect(validateBundleInvalidatedControlFrame(null)).toBe(false);
    expect(validateBundleInvalidatedControlFrame(undefined)).toBe(false);
    expect(validateBundleInvalidatedControlFrame("agent_control")).toBe(false);
    expect(validateBundleInvalidatedControlFrame(42)).toBe(false);
    expect(validateBundleInvalidatedControlFrame([])).toBe(false);
  });
});
