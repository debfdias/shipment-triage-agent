/**
 * Canonical domain model.
 *
 * The feed arrives in three carrier-specific shapes (UPSN / FXFE / ESTE), each with its
 * own field names, status vocabulary, and timestamp format. Everything downstream — the
 * trigger, the LLM, the EDI 214 writer — speaks ONLY this canonical model. Carrier quirks
 * are quarantined in the normalizers (src/ingest/normalize.ts).
 */

export type Carrier = "UPSN" | "FXFE" | "ESTE";

export const CARRIERS: readonly Carrier[] = ["UPSN", "FXFE", "ESTE"] as const;

/**
 * Carrier status codes collapsed into one vocabulary. Kept intentionally close to the
 * physical milestones a shipment passes through, plus the handful of "something is wrong"
 * states. UNKNOWN is a real, expected value — an unmapped code must surface, not vanish.
 */
export type CanonicalStatus =
  | "PICKED_UP"
  | "IN_TRANSIT"
  | "ARRIVED_FACILITY"
  | "DEPARTED_FACILITY"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "HELD"
  | "EXCEPTION"
  | "DELIVERY_EXCEPTION"
  | "DELAY"
  | "MISSED_APPOINTMENT"
  | "DAMAGED"
  | "UNKNOWN";

/** How we obtained the event timestamp — provenance matters for how far we trust it. */
export type TimestampSource =
  | "iso" // ISO-8601 with explicit offset (trustworthy)
  | "epoch_ms" // Unix epoch milliseconds, UTC by definition (trustworthy)
  | "naive_local"; // wall-clock string with NO timezone — assumed UTC (suspect)

export interface GeoPoint {
  city?: string;
  state?: string;
}

/** One carrier status event, normalized. `raw` is retained for observability/debugging. */
export interface NormalizedEvent {
  shipmentId: string;
  carrier: Carrier;
  status: CanonicalStatus;
  /** Original code/text exactly as the carrier sent it (e.g. "DE", 900, "DAMAGED IN TRANSIT"). */
  rawStatus: string;
  /** ISO-8601 UTC. */
  timestamp: string;
  timestampSource: TimestampSource;
  location?: GeoPoint;
  /** Promised/appointment delivery date, YYYY-MM-DD, if the carrier included one. */
  promisedDeliveryDate?: string;
  pieces?: number;
  weightLbs?: number;
  /** The original record, untouched — the ground truth for debugging a bad normalization. */
  raw: unknown;
  /** Non-fatal issues found while normalizing (unknown status, tz-less time, etc.). */
  warnings: string[];
}

/** A parse failure we chose to record rather than silently drop. */
export interface ParseError {
  lineNumber: number;
  rawLine: string;
  message: string;
}

export interface IngestResult {
  events: NormalizedEvent[];
  parseErrors: ParseError[];
}
