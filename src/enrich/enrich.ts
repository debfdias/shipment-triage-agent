/**
 * Enrichment: turn a flagged shipment into trustworthy detail — or an honest admission
 * that we couldn't get any.
 *
 * The API fights back (500s, 504 timeouts, and — nastier — 200 responses with garbage or
 * missing bodies). Strategy:
 *   - Retry transient failures AND untrustworthy/degraded 200 bodies, keeping the best
 *     result seen. Retrying a garbage 200 frequently yields a clean one.
 *   - Schema-validate every 200. A 200 is NOT proof of good data.
 *   - Cross-check the validated body against the feed we already have (carrier, promised
 *     date, scan ordering). A structurally valid body that CONTRADICTS the feed is demoted
 *     to DEGRADED — retrying won't fix a real contradiction, so we stop trusting it instead.
 *   - When we truly can't get clean data, return UNAVAILABLE and let the shipment proceed
 *     on feed-only data. We never fabricate, and never silently drop a shipment (the one we
 *     can't enrich may be the most broken).
 */

import type { NormalizedEvent } from "../types.js";
import type { ShipmentException } from "../trigger/rules.js";
import { TrackingDetailSchema, type TrackingDetail } from "./schema.js";
import { AuthError, TrackingClient, type FetchOutcome } from "./trackingClient.js";

export type TrustLevel =
  | "TRUSTED" // valid body, consistent with the feed
  | "DEGRADED" // usable but incomplete OR contradicts the feed
  | "UNTRUSTWORTHY" // 200 with a corrupt body (numeric status, ok:false, etc.)
  | "UNAVAILABLE"; // never got a usable body (404, or retries exhausted)

const TRUST_RANK: Record<TrustLevel, number> = {
  TRUSTED: 3,
  DEGRADED: 2,
  UNTRUSTWORTHY: 1,
  UNAVAILABLE: 0,
};

export interface EnrichmentResult {
  shipmentId: string;
  trust: TrustLevel;
  detail: TrackingDetail | null;
  attempts: number;
  /** Per-attempt summary, e.g. ["500", "504", "200-untrustworthy", "200-trusted"]. */
  outcomes: string[];
  /** Human-readable reasons for the trust verdict (drives observability + the LLM prompt). */
  trustReasons: string[];
}

export interface EnrichOptions {
  maxAttempts: number;
  /** Base backoff in ms; grows exponentially (capped) between attempts. */
  backoffMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Classify a single 200 body: is it good, thin-but-honest, or actively corrupt? */
function classifyBody(body: unknown): {
  trust: Exclude<TrustLevel, "UNAVAILABLE">;
  detail: TrackingDetail | null;
  reasons: string[];
} {
  const parsed = TrackingDetailSchema.safeParse(body);
  if (parsed.success) {
    return { trust: "TRUSTED", detail: parsed.data, reasons: [] };
  }

  // It failed the strict schema. Decide WHY: corrupt vs merely incomplete.
  const obj = (body ?? {}) as Record<string, unknown>;
  const reasons: string[] = [];
  let corrupt = false;

  if (obj.ok === false) {
    corrupt = true;
    reasons.push("body carries explicit ok:false");
  }
  if (typeof obj.currentStatus === "number") {
    corrupt = true;
    reasons.push(`currentStatus is a number (${obj.currentStatus}), expected a status string`);
  }
  if (obj.scanHistory === "unavailable" || (obj.scanHistory != null && !Array.isArray(obj.scanHistory))) {
    corrupt = true;
    reasons.push("scanHistory is not an array");
  }

  if (corrupt) return { trust: "UNTRUSTWORTHY", detail: null, reasons };

  // Not corrupt, just missing fields (the THIN body). Usable as partial context.
  reasons.push(
    `partial body — missing ${["currentStatus", "scanHistory"].filter((k) => !(k in obj)).join(", ") || "required fields"}`,
  );
  return { trust: "DEGRADED", detail: null, reasons };
}

/** Cross-check a validated body against the feed. Contradictions demote TRUSTED→DEGRADED. */
function crossCheck(detail: TrackingDetail, exc: ShipmentException): string[] {
  const reasons: string[] = [];

  if (detail.scac && detail.scac !== exc.carrier) {
    reasons.push(`API carrier (${detail.scac}) disagrees with feed carrier (${exc.carrier})`);
  }

  const feedPromised = latestPromised(exc.events);
  if (detail.promisedDeliveryDate && feedPromised && detail.promisedDeliveryDate !== feedPromised) {
    reasons.push(
      `promised date mismatch: API ${detail.promisedDeliveryDate} vs feed ${feedPromised}`,
    );
  }

  // Scan history that goes backwards in time is a data-integrity red flag (the SHP-00042
  // "departed Reno at 09:00, exception in Columbus at 06:00" pattern).
  const scans = detail.scanHistory;
  for (let i = 1; i < scans.length; i++) {
    if (new Date(scans[i]!.time).getTime() < new Date(scans[i - 1]!.time).getTime()) {
      reasons.push(
        `scanHistory is non-monotonic (${scans[i - 1]!.status}@${scans[i - 1]!.time} → ${scans[i]!.status}@${scans[i]!.time})`,
      );
      break;
    }
  }

  return reasons;
}

function latestPromised(events: NormalizedEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.promisedDeliveryDate) return events[i]!.promisedDeliveryDate;
  }
  return undefined;
}

/** Turn one raw fetch outcome into a trust verdict for this shipment. */
function scoreOutcome(
  outcome: FetchOutcome,
  exc: ShipmentException,
): { trust: TrustLevel; detail: TrackingDetail | null; label: string; reasons: string[] } {
  switch (outcome.kind) {
    case "timeout":
      return { trust: "UNAVAILABLE", detail: null, label: "timeout", reasons: ["request timed out"] };
    case "network_error":
      return {
        trust: "UNAVAILABLE",
        detail: null,
        label: "network_error",
        reasons: [`network error: ${outcome.message}`],
      };
    case "invalid_json":
      return {
        trust: "UNTRUSTWORTHY",
        detail: null,
        label: `${outcome.status}-invalid-json`,
        reasons: ["200-family response but body was not valid JSON"],
      };
    case "http": {
      const { status, body } = outcome;
      if (status === 404) {
        return {
          trust: "UNAVAILABLE",
          detail: null,
          label: "404",
          reasons: ["no tracking record for this shipment"],
        };
      }
      if (status >= 500) {
        return {
          trust: "UNAVAILABLE",
          detail: null,
          label: String(status),
          reasons: [`upstream ${status}`],
        };
      }
      if (status !== 200) {
        return {
          trust: "UNTRUSTWORTHY",
          detail: null,
          label: String(status),
          reasons: [`unexpected status ${status}`],
        };
      }
      // 200 — the body still has to earn our trust.
      const c = classifyBody(body);
      if (c.trust === "TRUSTED" && c.detail) {
        const contradictions = crossCheck(c.detail, exc);
        if (contradictions.length > 0) {
          return {
            trust: "DEGRADED",
            detail: c.detail,
            label: "200-contradicts-feed",
            reasons: contradictions,
          };
        }
        return { trust: "TRUSTED", detail: c.detail, label: "200-trusted", reasons: [] };
      }
      return {
        trust: c.trust,
        detail: c.detail,
        label: `200-${c.trust.toLowerCase()}`,
        reasons: c.reasons,
      };
    }
  }
}

/**
 * Enrich one flagged shipment: retry until TRUSTED or attempts exhausted, keeping the best
 * result seen. Throws AuthError (propagated from the client) so the run aborts on a bad key.
 */
export async function enrichShipment(
  client: TrackingClient,
  exc: ShipmentException,
  opts: EnrichOptions,
): Promise<EnrichmentResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const outcomes: string[] = [];

  let best: { trust: TrustLevel; detail: TrackingDetail | null; reasons: string[] } = {
    trust: "UNAVAILABLE",
    detail: null,
    reasons: ["no attempt succeeded"],
  };
  let attempts = 0;

  for (let i = 0; i < opts.maxAttempts; i++) {
    attempts++;
    const outcome = await client.fetchOnce(exc.shipmentId); // AuthError bubbles up by design
    const scored = scoreOutcome(outcome, exc);
    outcomes.push(scored.label);

    // >= so a later same-rank outcome replaces the initial placeholder with real reasons
    // (e.g. a 404's "no tracking record" instead of the default "no attempt succeeded").
    if (TRUST_RANK[scored.trust] >= TRUST_RANK[best.trust]) {
      best = { trust: scored.trust, detail: scored.detail, reasons: scored.reasons };
    }

    if (scored.trust === "TRUSTED") break; // can't do better
    if (outcome.kind === "http" && outcome.status === 404) break; // won't change on retry

    if (i < opts.maxAttempts - 1) {
      await sleep(Math.min(opts.backoffMs * 2 ** i, 3000));
    }
  }

  return {
    shipmentId: exc.shipmentId,
    trust: best.trust,
    detail: best.detail,
    attempts,
    outcomes,
    trustReasons: best.reasons,
  };
}

export { AuthError };
