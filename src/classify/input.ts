/**
 * Build the compact, data-grounded "shipment brief" handed to a classifier.
 *
 * Both providers (mock and Anthropic) consume the SAME ClassifierInput, so a classification
 * is a pure function of this object. That keeps the mock a faithful stand-in for the model
 * and makes runs reproducible and easy to eyeball in logs.
 */

import type { ShipmentException } from "../trigger/rules.js";
import type { EnrichmentResult } from "../enrich/enrich.js";

export interface ClassifierInput {
  shipmentId: string;
  carrier: string;
  latestStatus: string;
  triggerFlags: { reason: string; detail: string }[];
  /** Compact oldest→newest timeline from the feed. */
  timeline: { ts: string; status: string; location: string; tsSource: string }[];
  enrichment: {
    trust: EnrichmentResult["trust"];
    attempts: number;
    trustReasons: string[];
    currentStatus?: string;
    statusReason?: string;
    promisedDeliveryDate?: string;
    estimatedDeliveryDate?: string;
    exceptionNotes?: string;
    scanCount?: number;
  };
  /** Normalization + trust warnings the classifier should weigh (don't over-trust). */
  dataWarnings: string[];
}

function loc(e: { location?: { city?: string; state?: string } }): string {
  if (!e.location) return "?";
  return [e.location.city, e.location.state].filter(Boolean).join(", ") || "?";
}

export function buildClassifierInput(
  exc: ShipmentException,
  enr: EnrichmentResult,
): ClassifierInput {
  const d = enr.detail;
  return {
    shipmentId: exc.shipmentId,
    carrier: exc.carrier,
    latestStatus: exc.latest.status,
    triggerFlags: exc.flags.map((f) => ({ reason: f.reason, detail: f.detail })),
    timeline: exc.events.map((e) => ({
      ts: e.timestamp,
      status: e.status,
      location: loc(e),
      tsSource: e.timestampSource,
    })),
    enrichment: {
      trust: enr.trust,
      attempts: enr.attempts,
      trustReasons: enr.trustReasons,
      currentStatus: d?.currentStatus,
      statusReason: d?.statusReason,
      promisedDeliveryDate: d?.promisedDeliveryDate,
      estimatedDeliveryDate: d?.estimatedDeliveryDate,
      exceptionNotes: d?.exceptionNotes,
      scanCount: d?.scanHistory?.length,
    },
    dataWarnings: Array.from(new Set([...exc.warnings, ...enr.trustReasons])),
  };
}
