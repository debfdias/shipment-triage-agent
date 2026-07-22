/**
 * The trigger: decide which shipments are exceptions worth a human's attention.
 *
 * Design stance (documented in README): high-recall "first-pass" triage. We would rather
 * flag a borderline shipment and let enrichment + the LLM downgrade it than let a real
 * problem stay buried. Every rule below is cheap, explainable, and computed purely from
 * the normalized feed — no network calls here.
 *
 * Reference clock: these rules need a "now". The dataset is a historical capture, so a
 * wall-clock now would flag every shipment as stalled. We default `now` to the latest
 * event timestamp in the feed (the capture moment) and allow an override.
 */

import type { Carrier, NormalizedEvent } from "../types.js";

export type ExceptionReason =
  | "CARRIER_EXCEPTION" // carrier itself reported trouble
  | "LATE_VS_PROMISE" // promised date passed, not delivered
  | "AT_RISK" // promised date imminent, not on the truck
  | "STALLED" // no forward scan for too long
  | "HELD" // held at facility, needs intervention
  | "DATA_INTEGRITY"; // feed contradicts itself — can't be trusted as-is

export interface TriggerFlag {
  reason: ExceptionReason;
  detail: string;
}

export interface ShipmentException {
  shipmentId: string;
  carrier: Carrier;
  /** Full timeline, oldest → newest. */
  events: NormalizedEvent[];
  /** Most recent event. */
  latest: NormalizedEvent;
  flags: TriggerFlag[];
  /** Normalization warnings accumulated across the timeline (trust signals). */
  warnings: string[];
}

export interface TriageOptions {
  /** Hours of scan silence (while in transit) before a shipment is "stalled". */
  stallHours: number;
  /** Reference clock (ISO). Defaults to the feed's latest event time. */
  now?: string;
}

export interface TriageResult {
  now: string;
  exceptions: ShipmentException[];
  /** Shipments examined but not flagged (delivered/clean) — counted for observability. */
  skipped: number;
  total: number;
}

const EXCEPTION_STATUSES = new Set([
  "EXCEPTION",
  "DELIVERY_EXCEPTION",
  "DAMAGED",
  "MISSED_APPOINTMENT",
]);

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/** End of the promised day (exclusive) in UTC: promised date + 1 day at 00:00Z. */
function promisedDeadlineMs(dateYmd: string): number | null {
  const m = dateYmd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + DAY_MS;
}

/** Latest event timestamp across all shipments — used as the default reference clock. */
export function feedClock(byShipment: Map<string, NormalizedEvent[]>): string {
  let max = 0;
  for (const events of byShipment.values()) {
    for (const e of events) max = Math.max(max, ms(e.timestamp));
  }
  return new Date(max || Date.now()).toISOString();
}

function detectFlags(
  events: NormalizedEvent[],
  latest: NormalizedEvent,
  nowMs: number,
  stallHours: number,
): TriggerFlag[] {
  const flags: TriggerFlag[] = [];
  const delivered = latest.status === "DELIVERED";

  // Progress-based rules only apply while the shipment is still in flight. A delivered
  // shipment is resolved; the only thing worth surfacing on it is a broken timeline
  // (handled by the data-integrity checks below, which always run).
  if (!delivered) {
    // 1. Carrier explicitly reported an exception anywhere in the timeline.
    const carrierExc = events.find((e) => EXCEPTION_STATUSES.has(e.status));
    if (carrierExc) {
      flags.push({
        reason: "CARRIER_EXCEPTION",
        detail: `carrier reported ${carrierExc.status} (${carrierExc.rawStatus}) at ${carrierExc.timestamp}`,
      });
    }

    // 2. Held at facility.
    if (latest.status === "HELD") {
      flags.push({ reason: "HELD", detail: `held at ${loc(latest)} since ${latest.timestamp}` });
    }

    // 3 & 4. Promise-based rules (only if a promised date exists).
    const promised = latest.promisedDeliveryDate ?? findPromised(events);
    if (promised) {
      const deadline = promisedDeadlineMs(promised);
      if (deadline !== null) {
        if (nowMs >= deadline) {
          flags.push({
            reason: "LATE_VS_PROMISE",
            detail: `promised ${promised}, still ${latest.status} as of clock`,
          });
        } else if (deadline - nowMs <= DAY_MS && latest.status !== "OUT_FOR_DELIVERY") {
          flags.push({
            reason: "AT_RISK",
            detail: `promised ${promised} (<24h away) but only ${latest.status}`,
          });
        }
      }
    }

    // 5. Stalled: no forward movement for too long while still in transit.
    const silentHours = (nowMs - ms(latest.timestamp)) / HOUR_MS;
    const inMotion = [
      "IN_TRANSIT",
      "ARRIVED_FACILITY",
      "DEPARTED_FACILITY",
      "PICKED_UP",
    ].includes(latest.status);
    if (inMotion && silentHours > stallHours) {
      flags.push({
        reason: "STALLED",
        detail: `no new scan for ${silentHours.toFixed(0)}h (last: ${latest.status} @ ${latest.timestamp})`,
      });
    }
  }

  // 6. Data integrity: the feed contradicts itself. Runs for ALL shipments, delivered or
  //    not. Two cheap, high-signal checks:
  //    (a) activity after a DELIVERED scan (status regression),
  //    (b) two events at the same instant with different statuses.
  const deliveredIdx = events.findIndex((e) => e.status === "DELIVERED");
  if (deliveredIdx !== -1 && deliveredIdx < events.length - 1) {
    flags.push({
      reason: "DATA_INTEGRITY",
      detail: `${events.length - 1 - deliveredIdx} event(s) recorded after a DELIVERED scan`,
    });
  }
  for (let i = 1; i < events.length; i++) {
    if (
      events[i]!.timestamp === events[i - 1]!.timestamp &&
      events[i]!.status !== events[i - 1]!.status
    ) {
      flags.push({
        reason: "DATA_INTEGRITY",
        detail: `conflicting statuses at same timestamp ${events[i]!.timestamp} (${events[i - 1]!.status} vs ${events[i]!.status})`,
      });
      break;
    }
  }

  return flags;
}

function findPromised(events: NormalizedEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.promisedDeliveryDate) return events[i]!.promisedDeliveryDate;
  }
  return undefined;
}

function loc(e: NormalizedEvent): string {
  if (!e.location) return "unknown location";
  return [e.location.city, e.location.state].filter(Boolean).join(", ") || "unknown location";
}

/**
 * Apply the trigger across every shipment. Delivered-and-clean shipments are treated as
 * resolved noise and skipped — but a delivered shipment with a data-integrity problem is
 * still surfaced (the timeline can't be trusted).
 */
export function triage(
  byShipment: Map<string, NormalizedEvent[]>,
  opts: TriageOptions,
): TriageResult {
  const now = opts.now ?? feedClock(byShipment);
  const nowMs = ms(now);

  const exceptions: ShipmentException[] = [];
  let skipped = 0;

  for (const [shipmentId, events] of byShipment) {
    const latest = events[events.length - 1]!;
    const flags = detectFlags(events, latest, nowMs, opts.stallHours);

    // No flags -> clean/resolved shipment -> noise, filtered out. (Delivered shipments
    // reach this point with at most DATA_INTEGRITY flags; those still surface.)
    if (flags.length === 0) {
      skipped++;
      continue;
    }

    exceptions.push({
      shipmentId,
      carrier: latest.carrier,
      events,
      latest,
      flags,
      warnings: Array.from(new Set(events.flatMap((e) => e.warnings))),
    });
  }

  // Stable, useful ordering: most flags first, then by id for determinism.
  exceptions.sort((a, b) => b.flags.length - a.flags.length || a.shipmentId.localeCompare(b.shipmentId));

  return { now, exceptions, skipped, total: byShipment.size };
}
