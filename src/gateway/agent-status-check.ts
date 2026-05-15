/**
 * Pre-dispatch agent status check (Protocol v2, NOR-4841).
 *
 * Before each job dispatch, the gateway polls Paperclip to verify the agent is
 * not paused. This is a defence-in-depth complement to the `terminate_session`
 * control frame: it catches pause commands that may have arrived while the
 * WebSocket was mid-reconnect or the control frame was missed.
 */

const STATUS_CHECK_TIMEOUT_MS = 5_000;

export type AgentStatusCheckResult =
  | { status: "active" }
  | { status: "paused" }
  | { status: "unavailable"; reason: string };

/**
 * Fetch the agent's current status from Paperclip with a hard 5 s timeout.
 * Returns:
 *   - "active"      — agent is running normally, proceed with dispatch
 *   - "paused"      — agent is paused; caller must reject the job
 *   - "unavailable" — API unreachable / misconfigured; caller should fail-open
 */
export async function checkAgentStatusBeforeDispatch(
  agentId: string,
): Promise<AgentStatusCheckResult> {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) {
    return {
      status: "unavailable",
      reason: "PAPERCLIP_API_URL or PAPERCLIP_API_KEY not configured",
    };
  }

  const cfId = process.env.CF_ACCESS_CLIENT_ID || undefined;
  const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET || undefined;

  const url = `${apiUrl.replace(/\/$/, "")}/api/agents/${encodeURIComponent(agentId)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (cfId && cfSecret) {
    headers["CF-Access-Client-Id"] = cfId;
    headers["CF-Access-Client-Secret"] = cfSecret;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      return { status: "unavailable", reason: `HTTP ${res.status} from agent status endpoint` };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { status: "unavailable", reason: "invalid JSON in agent status response" };
    }
    const agentStatus =
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>).status
        : undefined;
    if (agentStatus === "paused") {
      return { status: "paused" };
    }
    return { status: "active" };
  } catch (err) {
    return { status: "unavailable", reason: `network error: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
