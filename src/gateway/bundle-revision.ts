import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";

/**
 * In-memory cache of sessionKey → bundleRevisionId last seen.
 * Bounded to prevent unbounded growth in long-running gateway processes.
 */
const bundleRevisionCache = new Map<string, string>();
const BUNDLE_REVISION_CACHE_LIMIT = 512;

/**
 * Retry delay schedule: attempt 1 immediately, then wait 2s, 8s, 32s between retries.
 */
const RETRY_DELAYS_MS = [2_000, 8_000, 32_000];

export type BundleCheckResult =
  | { status: "skip" }
  | { status: "match" }
  | { status: "refreshed"; bundleRevisionId: string }
  | { status: "unavailable"; error: string };

type BundleResponse = {
  bundleRevisionId: string;
  bundleAssembledAt: string;
  text: string;
  entryFile: string;
  manifest: unknown;
  warnings: unknown[];
};

type FetchBundleResult = { ok: true; bundle: BundleResponse } | { ok: false; error: string };

async function fetchBundle(params: {
  agentId: string;
  apiUrl: string;
  apiKey: string;
  cfId: string | undefined;
  cfSecret: string | undefined;
}): Promise<FetchBundleResult> {
  const { agentId, apiUrl, apiKey, cfId, cfSecret } = params;
  const url = `${apiUrl.replace(/\/$/, "")}/api/agents/${encodeURIComponent(agentId)}/bundle`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (cfId && cfSecret) {
    headers["CF-Access-Client-Id"] = cfId;
    headers["CF-Access-Client-Secret"] = cfSecret;
  }
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    return { ok: false, error: `network error: ${String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status} from bundle endpoint` };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, error: `invalid JSON in bundle response: ${String(err)}` };
  }
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as Record<string, unknown>).bundleRevisionId !== "string" ||
    typeof (data as Record<string, unknown>).text !== "string"
  ) {
    return { ok: false, error: "bundle response missing bundleRevisionId or text" };
  }
  const raw = data as Record<string, unknown>;
  return {
    ok: true,
    bundle: {
      bundleRevisionId: raw.bundleRevisionId as string,
      bundleAssembledAt: typeof raw.bundleAssembledAt === "string" ? raw.bundleAssembledAt : "",
      text: raw.text as string,
      entryFile:
        typeof raw.entryFile === "string" && raw.entryFile.trim()
          ? raw.entryFile.trim()
          : "AGENTS.md",
      manifest: raw.manifest,
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchBundleWithRetry(params: {
  agentId: string;
  apiUrl: string;
  apiKey: string;
  cfId: string | undefined;
  cfSecret: string | undefined;
}): Promise<FetchBundleResult> {
  let lastError = "unknown error";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 0;
      await sleep(delayMs);
    }
    const result = await fetchBundle(params);
    if (result.ok) {
      return result;
    }
    lastError = result.error;
  }
  return { ok: false, error: lastError };
}

function pruneBundleRevisionCache() {
  if (bundleRevisionCache.size <= BUNDLE_REVISION_CACHE_LIMIT) {
    return;
  }
  // Delete the oldest entries until we are back under the limit.
  const excess = bundleRevisionCache.size - BUNDLE_REVISION_CACHE_LIMIT;
  let pruned = 0;
  for (const key of bundleRevisionCache.keys()) {
    bundleRevisionCache.delete(key);
    pruned++;
    if (pruned >= excess) {
      break;
    }
  }
}

/**
 * Check the incoming bundleRevisionId against the cached value for this sessionKey.
 * On a mismatch, fetch the latest bundle from Paperclip and write it to the agent's workspace.
 * Returns:
 *   - "skip"      — bundleRevisionId was not provided; nothing to do
 *   - "match"     — cached revision matches; skip reload
 *   - "refreshed" — bundle was fetched and written to the workspace
 *   - "unavailable" — bundle could not be fetched after all retries
 */
export async function checkAndReloadBundleRevision(params: {
  sessionKey: string;
  agentId: string;
  bundleRevisionId: string | null | undefined;
}): Promise<BundleCheckResult> {
  const { sessionKey, agentId, bundleRevisionId: incomingRevision } = params;

  if (!incomingRevision) {
    return { status: "skip" };
  }

  const cached = bundleRevisionCache.get(sessionKey);
  if (cached === incomingRevision) {
    return { status: "match" };
  }

  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) {
    return {
      status: "unavailable",
      error: "PAPERCLIP_API_URL or PAPERCLIP_API_KEY not configured on this gateway",
    };
  }

  const cfId = process.env.CF_ACCESS_CLIENT_ID || undefined;
  const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET || undefined;

  const result = await fetchBundleWithRetry({ agentId, apiUrl, apiKey, cfId, cfSecret });
  if (!result.ok) {
    return { status: "unavailable", error: result.error };
  }

  const { bundle } = result;

  // Write the new bundle content to the agent's workspace directory.
  // If the write fails we log it but continue — the old AGENTS.md is still usable.
  try {
    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    if (workspaceDir) {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, bundle.entryFile), bundle.text, "utf-8");
    }
  } catch {
    // Best-effort write; do not fail the bundle check for a transient I/O error.
  }

  // Update the cache with the revision we just confirmed from the server.
  bundleRevisionCache.set(sessionKey, bundle.bundleRevisionId);
  pruneBundleRevisionCache();

  return { status: "refreshed", bundleRevisionId: bundle.bundleRevisionId };
}

/**
 * Exposed for testing only: clears the internal bundle revision cache.
 * @internal
 */
export function _clearBundleRevisionCacheForTest() {
  bundleRevisionCache.clear();
}
