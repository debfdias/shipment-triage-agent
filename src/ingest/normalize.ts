/**
 * Carrier-specific normalizers.
 *
 * Each carrier speaks a different dialect. We detect the dialect by which id field is
 * present, then map into the canonical NormalizedEvent. All the "this carrier is weird"
 * knowledge lives here and nowhere else.
 */

import type {
  CanonicalStatus,
  Carrier,
  NormalizedEvent,
  TimestampSource,
} from "../types.js";

// --- Status maps -----------------------------------------------------------------------

const UPSN_STATUS: Record<string, CanonicalStatus> = {
  PU: "PICKED_UP",
  IT: "IN_TRANSIT",
  AR: "ARRIVED_FACILITY",
  DP: "DEPARTED_FACILITY",
  OD: "OUT_FOR_DELIVERY",
  DL: "DELIVERED",
  HL: "HELD",
  EX: "EXCEPTION",
  DE: "DELIVERY_EXCEPTION",
};

const FXFE_STATUS: Record<number, CanonicalStatus> = {
  100: "PICKED_UP",
  200: "IN_TRANSIT",
  300: "ARRIVED_FACILITY",
  320: "DEPARTED_FACILITY",
  400: "OUT_FOR_DELIVERY",
  500: "DELIVERED",
  850: "HELD",
  900: "DELIVERY_EXCEPTION",
  950: "DELAY",
};

const ESTE_STATUS: Record<string, CanonicalStatus> = {
  "PICKED UP": "PICKED_UP",
  "IN TRANSIT": "IN_TRANSIT",
  "ARRIVED AT TERMINAL": "ARRIVED_FACILITY",
  "DEPARTED TERMINAL": "DEPARTED_FACILITY",
  "OUT FOR DELIVERY": "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  "DELAYED - WEATHER": "DELAY",
  "DELAYED - MECHANICAL": "DELAY",
  "MISSED DELIVERY APPOINTMENT": "MISSED_APPOINTMENT",
  "DAMAGED IN TRANSIT": "DAMAGED",
  "HELD - CONSIGNEE CLOSED": "HELD",
};

// --- Time helpers ----------------------------------------------------------------------

/** ISO string with an explicit offset → keep as UTC. */
function fromIso(s: string): { iso: string; source: TimestampSource } | null {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return { iso: d.toISOString(), source: "iso" };
}

/** Unix epoch milliseconds (FXFE). */
function fromEpochMs(ms: number): { iso: string; source: TimestampSource } | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return { iso: d.toISOString(), source: "epoch_ms" };
}

/**
 * ESTE sends "MM/DD/YYYY HH:MM" with NO timezone. We CANNOT know the true offset, so we
 * assume UTC and mark it naive_local. This is a deliberate, documented assumption: it is
 * flagged as a warning and used as a trust signal downstream, not hidden.
 */
function fromNaive(s: string): { iso: string; source: TimestampSource } | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, min] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${min}:00Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { iso: d.toISOString(), source: "naive_local" };
}

/** "Reno, NV" → { city: "Reno", state: "NV" }. */
function splitTerminal(terminal: unknown): { city?: string; state?: string } | undefined {
  if (typeof terminal !== "string") return undefined;
  const [city, state] = terminal.split(",").map((p) => p.trim());
  return { city: city || undefined, state: state || undefined };
}

// --- Per-carrier normalizers -----------------------------------------------------------

function normalizeUpsn(o: Record<string, unknown>): NormalizedEvent {
  const warnings: string[] = [];
  const rawStatus = String(o.statusCode ?? "");
  const status = UPSN_STATUS[rawStatus] ?? "UNKNOWN";
  if (status === "UNKNOWN") warnings.push(`unmapped UPSN statusCode "${rawStatus}"`);

  const t = typeof o.ts === "string" ? fromIso(o.ts) : null;
  if (!t) warnings.push(`unparseable UPSN ts "${String(o.ts)}"`);

  return {
    shipmentId: String(o.shipmentId),
    carrier: "UPSN",
    status,
    rawStatus: `${rawStatus}${o.statusText ? ` (${o.statusText})` : ""}`,
    timestamp: t?.iso ?? new Date(0).toISOString(),
    timestampSource: t?.source ?? "iso",
    location: pickGeo(o.city, o.state),
    promisedDeliveryDate:
      typeof o.promisedDeliveryDate === "string" ? o.promisedDeliveryDate : undefined,
    raw: o,
    warnings,
  };
}

function normalizeFxfe(o: Record<string, unknown>): NormalizedEvent {
  const warnings: string[] = [];
  const event = (o.event ?? {}) as Record<string, unknown>;
  const code = typeof event.code === "number" ? event.code : NaN;
  const status = FXFE_STATUS[code] ?? "UNKNOWN";
  if (status === "UNKNOWN") warnings.push(`unmapped FXFE event code "${String(event.code)}"`);

  const t = typeof o.event_time === "number" ? fromEpochMs(o.event_time) : null;
  if (!t) warnings.push(`unparseable FXFE event_time "${String(o.event_time)}"`);

  const loc = (o.location ?? {}) as Record<string, unknown>;

  return {
    shipmentId: String(o.tracking_number),
    carrier: "FXFE",
    status,
    rawStatus: `${event.code ?? ""}${event.description ? ` (${event.description})` : ""}`,
    timestamp: t?.iso ?? new Date(0).toISOString(),
    timestampSource: t?.source ?? "epoch_ms",
    location: pickGeo(loc.city, loc.region), // FXFE calls it "region", not "state"
    promisedDeliveryDate: typeof o.sla_date === "string" ? o.sla_date : undefined,
    raw: o,
    warnings,
  };
}

function normalizeEste(o: Record<string, unknown>): NormalizedEvent {
  const warnings: string[] = [];
  const rawStatus = String(o.status ?? "");
  const status = ESTE_STATUS[rawStatus.toUpperCase()] ?? "UNKNOWN";
  if (status === "UNKNOWN") warnings.push(`unmapped ESTE status "${rawStatus}"`);

  const t = typeof o.datetime === "string" ? fromNaive(o.datetime) : null;
  if (!t) warnings.push(`unparseable ESTE datetime "${String(o.datetime)}"`);
  else if (t.source === "naive_local")
    warnings.push("ESTE datetime has no timezone; assumed UTC");

  return {
    shipmentId: String(o.pro_number),
    carrier: "ESTE",
    status,
    rawStatus,
    timestamp: t?.iso ?? new Date(0).toISOString(),
    timestampSource: t?.source ?? "naive_local",
    location: splitTerminal(o.terminal),
    promisedDeliveryDate: typeof o.appt === "string" ? o.appt : undefined,
    pieces: typeof o.pieces === "number" ? o.pieces : undefined,
    weightLbs: typeof o.weight === "number" ? o.weight : undefined,
    raw: o,
    warnings,
  };
}

function pickGeo(city: unknown, state: unknown): { city?: string; state?: string } | undefined {
  const c = typeof city === "string" ? city : undefined;
  const s = typeof state === "string" ? state : undefined;
  return c || s ? { city: c, state: s } : undefined;
}

// --- Dispatch --------------------------------------------------------------------------

/**
 * Detect the carrier dialect from which id field is present and route to its normalizer.
 * We key off the id field rather than `scac`/`carrier` because those are themselves
 * inconsistent (FXFE uses `carrier`, others use `scac`, some records omit it).
 */
export function normalizeEvent(o: Record<string, unknown>): NormalizedEvent {
  if ("shipmentId" in o) return normalizeUpsn(o);
  if ("tracking_number" in o) return normalizeFxfe(o);
  if ("pro_number" in o) return normalizeEste(o);
  throw new Error(
    `unrecognized event shape — no shipmentId/tracking_number/pro_number: ${JSON.stringify(
      Object.keys(o),
    )}`,
  );
}

export const CARRIER_OF: Record<Carrier, string> = {
  UPSN: "UPS",
  FXFE: "FedEx Freight",
  ESTE: "Estes Express",
};
