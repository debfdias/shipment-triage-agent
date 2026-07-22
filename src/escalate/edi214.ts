/**
 * EDI 214 (Transportation Carrier Shipment Status) writer — ANSI ASC X12 version 004010.
 *
 * Produces a COMPLETE interchange (ISA/GS envelope → ST…SE transaction → GE/IEA trailers)
 * so it can be handed to a carrier's EDI system as-is. Delimiters: element "*",
 * sub-element ">", segment "~". Segments are newline-separated for readability (the "~"
 * terminator is what actually delimits them; newlines are ignored by parsers).
 *
 * Confidence & honesty (video Q1): this is structurally valid X12 with legitimate codes,
 * correct segment order, and a well-formed fixed-width ISA. It is NOT certified against a
 * specific carrier's companion guide — sender/receiver IDs and the AT7 code subset would be
 * agreed per trading partner. Usage indicator is "T" (test) precisely because this is a
 * demo, not a production interchange.
 */

import type { ShipmentException } from "../trigger/rules.js";
import type { EnrichmentResult } from "../enrich/enrich.js";
import type { Classification } from "../classify/schema.js";
import { resolveAt7, type At7Codes } from "./at7.js";

const EL = "*"; // element separator
const SEG = "~"; // segment terminator
const SUB = ">"; // component/sub-element separator

export interface Edi214Options {
  /** Our application sender id (ISA06 / GS02). */
  senderId: string;
  /** Monotonic control number for this escalation (ISA13 / GS06 / ST02). */
  controlNumber: number;
  /** Run clock, used for the interchange/group date-time stamps. */
  now: Date;
  /** "P" production or "T" test. Defaults to test. */
  usage?: "P" | "T";
}

export interface Escalation {
  shipmentId: string;
  carrier: string;
  controlNumber: number;
  at7: At7Codes;
  /** The severity/category that triggered escalation — for the run report, not the EDI. */
  classification: Pick<Classification, "category" | "severity" | "recommendedAction">;
  edi214: string;
}

/** Right-pad (or truncate) to a fixed width — required for the ISA segment's fixed fields. */
function fix(value: string, width: number): string {
  return value.slice(0, width).padEnd(width, " ");
}

function pad9(n: number): string {
  return String(n % 1_000_000_000).padStart(9, "0");
}

/** ISA date is YYMMDD, GS date is CCYYMMDD, both in UTC. */
function isaDate(d: Date): string {
  return d.toISOString().slice(2, 10).replace(/-/g, "");
}
function gsDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
function hhmm(d: Date): string {
  return d.toISOString().slice(11, 16).replace(":", "");
}
/** AT7 date/time (CCYYMMDD / HHMM) from an event ISO timestamp, in UTC. */
function eventDate(iso: string): string {
  return gsDate(new Date(iso));
}
function eventTime(iso: string): string {
  return hhmm(new Date(iso));
}

function seg(...elements: (string | number)[]): string {
  return elements.map((e) => String(e)).join(EL) + SEG;
}

/** Build one EDI 214 interchange for a single escalated shipment. */
export function buildEdi214(
  exc: ShipmentException,
  enr: EnrichmentResult,
  classification: Classification,
  opts: Edi214Options,
): Escalation {
  const now = opts.now;
  const usage = opts.usage ?? "T";
  const scac = exc.carrier;
  const refs = enr.detail?.referenceNumbers ?? {};
  const at7 = resolveAt7(
    classification.category,
    enr.detail?.statusReason,
    enr.detail?.exceptionNotes,
    exc.latest.rawStatus,
  );

  const latest = exc.latest;
  const city = latest.location?.city ?? enr.detail?.destination?.city ?? "";
  const state = latest.location?.state ?? enr.detail?.destination?.state ?? "";

  const control = opts.controlNumber;
  const stControl = String(control).padStart(4, "0");

  // --- Interchange envelope (ISA is fixed-width; every element has a mandated length) ---
  const isa = [
    "ISA",
    "00",
    fix("", 10), // no authorization info
    "00",
    fix("", 10), // no security info
    "ZZ",
    fix(opts.senderId, 15),
    "ZZ",
    fix(scac, 15),
    isaDate(now),
    hhmm(now),
    "U",
    "00401",
    pad9(control),
    "0", // no ack requested
    usage,
    SUB, // ISA16 component separator = the sub-element char itself
  ].join(EL) + SEG;

  const gs = seg("GS", "QM", opts.senderId, scac, gsDate(now), hhmm(now), control, "X", "004010");

  // --- Transaction set ---
  const body: string[] = [];
  body.push(seg("ST", "214", stControl));
  // B10: reference id (shipment), shipment id number, SCAC
  body.push(seg("B10", exc.shipmentId, refs.orderId ?? exc.shipmentId, scac));
  if (refs.bolNumber) body.push(seg("L11", refs.bolNumber, "BM")); // BM = Bill of Lading
  if (refs.poNumber) body.push(seg("L11", refs.poNumber, "PO")); // PO = Purchase Order
  if (refs.orderId) body.push(seg("L11", refs.orderId, "CR")); // CR = Customer Reference
  body.push(seg("N1", "CA", carrierName(scac))); // CA = Carrier party
  body.push(seg("LX", "1"));
  // AT7: status, reason, (appt status, appt reason blank), date, time, LT = local time
  body.push(seg("AT7", at7.statusCode, at7.reasonCode, "", "", eventDate(latest.timestamp), eventTime(latest.timestamp), "LT"));
  if (city || state) body.push(seg("MS1", city, state)); // status location

  // SE segment count = ST through SE inclusive.
  const seCount = body.length + 1;
  body.push(seg("SE", seCount, stControl));

  const ge = seg("GE", "1", control);
  const iea = seg("IEA", "1", pad9(control));

  const edi214 = [isa, gs, ...body, ge, iea].join("\n");

  return {
    shipmentId: exc.shipmentId,
    carrier: scac,
    controlNumber: control,
    at7,
    classification: {
      category: classification.category,
      severity: classification.severity,
      recommendedAction: classification.recommendedAction,
    },
    edi214,
  };
}

function carrierName(scac: string): string {
  const names: Record<string, string> = {
    UPSN: "UPS",
    FXFE: "FEDEX FREIGHT",
    ESTE: "ESTES EXPRESS",
  };
  return names[scac] ?? scac;
}
