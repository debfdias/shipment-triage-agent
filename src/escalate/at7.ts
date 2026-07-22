/**
 * Map our internal classification to real ANSI ASC X12 4010 AT7 codes.
 *
 * AT7-01 = element 1650 (Shipment Status Code) — the disposition.
 * AT7-02 = element 1651 (Shipment Status or Appointment Reason Code) — the cause.
 *
 * Codes verified against the public X12 004010 code lists (element 1650 / 1651) and carrier
 * 214 implementation guides. They are best-effort: a specific carrier's companion guide may
 * subset or rename these, so final acceptance requires reconciliation with that guide. This
 * table is the single documented place where that mapping lives.
 */

import type { Category } from "../classify/schema.js";

/** Element 1650 values we emit (subset, with descriptions for the README + logs). */
export const STATUS_1650: Record<string, string> = {
  SD: "Shipment Delayed",
  AP: "Delivery Not Completed",
  AH: "Attempted Delivery",
  AG: "Estimated Delivery",
  X1: "Arrived at Delivery Location",
  X6: "En Route to Delivery Location",
  CB: "Completed Shipment",
};

/** Element 1651 values we emit (subset, with descriptions). */
export const REASON_1651: Record<string, string> = {
  AK: "Damaged, Rewrapped in Hub",
  AO: "Weather or Natural Disaster Related",
  AI: "Mechanical Breakdown",
  A1: "Missed Delivery",
  A2: "Incorrect Address",
  B5: "Held for Consignee",
  B1: "Consignee Closed",
  BS: "Refused by Customer",
  AJ: "Other Carrier Related",
  BG: "Other",
};

export interface At7Codes {
  statusCode: string; // AT7-01 (1650)
  reasonCode: string; // AT7-02 (1651)
  statusDesc: string;
  reasonDesc: string;
}

const STATUS_BY_CATEGORY: Record<Category, string> = {
  DAMAGED: "AP",
  DELIVERY_EXCEPTION: "AP",
  HELD: "SD",
  LOST_OR_STALLED: "SD",
  LATE_DELIVERY: "SD",
  WEATHER_DELAY: "SD",
  MISROUTED: "SD",
  DATA_QUALITY: "SD",
};

const REASON_BY_CATEGORY: Record<Category, string> = {
  DAMAGED: "AK",
  DELIVERY_EXCEPTION: "A1",
  HELD: "B5",
  LOST_OR_STALLED: "BG",
  LATE_DELIVERY: "AJ",
  WEATHER_DELAY: "AO",
  MISROUTED: "AJ",
  DATA_QUALITY: "BG",
};

/**
 * Resolve AT7 codes. The status code comes from the category; the reason code prefers a
 * concrete signal in the carrier's own text (statusReason / status / notes) before falling
 * back to the category default — so "CONSIGNEE CLOSED" becomes B1, "WEATHER" becomes AO, etc.
 */
export function resolveAt7(category: Category, ...signals: (string | undefined)[]): At7Codes {
  const text = signals.filter(Boolean).join(" ").toUpperCase();

  let reasonCode = REASON_BY_CATEGORY[category];
  if (/DAMAGE/.test(text)) reasonCode = "AK";
  else if (/WEATHER|STORM|SNOW|FLOOD/.test(text)) reasonCode = "AO";
  else if (/MECHANIC|BREAKDOWN|EQUIPMENT/.test(text)) reasonCode = "AI";
  else if (/REFUSED/.test(text)) reasonCode = "BS";
  else if (/CLOSED/.test(text)) reasonCode = "B1";
  else if (/MISSED|MISS(ED)? (APPT|APPOINTMENT|DELIVERY)/.test(text)) reasonCode = "A1";
  else if (/ADDRESS/.test(text)) reasonCode = "A2";
  else if (/HELD|HOLD/.test(text)) reasonCode = "B5";

  const statusCode = STATUS_BY_CATEGORY[category];
  return {
    statusCode,
    reasonCode,
    statusDesc: STATUS_1650[statusCode] ?? "Unknown",
    reasonDesc: REASON_1651[reasonCode] ?? "Unknown",
  };
}
