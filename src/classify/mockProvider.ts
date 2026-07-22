/**
 * Deterministic, rule-based classifier. Stands in for the LLM so the whole pipeline runs
 * with no API key and zero cost, and gives eval/tests a stable oracle. It mirrors the
 * reasoning we'd expect from the model: read the trigger flags + enrichment, pick the
 * dominant problem, set severity, and recommend an action — grounded in the real data.
 */

import type { Classifier } from "./provider.js";
import type { ClassifierInput } from "./input.js";
import type { Action, Category, Classification, Severity } from "./schema.js";

function has(input: ClassifierInput, reason: string): boolean {
  return input.triggerFlags.some((f) => f.reason === reason);
}

export class MockClassifier implements Classifier {
  readonly name = "mock";

  async classify(input: ClassifierInput): Promise<Classification> {
    const reason = input.enrichment.statusReason?.toUpperCase() ?? "";
    const status = (input.enrichment.currentStatus ?? input.latestStatus).toUpperCase();
    const lowTrust = input.enrichment.trust === "UNAVAILABLE" || input.enrichment.trust === "UNTRUSTWORTHY";

    let category: Category;
    let severity: Severity;
    let action: Action;

    // Priority order: physical damage > lost/stalled > delivery exceptions > held >
    // weather > late > data quality. Highest-consequence problem wins.
    if (status.includes("DAMAGED") || reason.includes("DAMAGE")) {
      category = "DAMAGED";
      severity = "HIGH";
      action = "ESCALATE_TO_CARRIER";
    } else if (has(input, "STALLED") && has(input, "LATE_VS_PROMISE")) {
      category = "LOST_OR_STALLED";
      severity = "HIGH";
      action = "ESCALATE_TO_CARRIER";
    } else if (has(input, "STALLED")) {
      category = "LOST_OR_STALLED";
      severity = "MEDIUM";
      action = "CONTACT_CARRIER";
    } else if (reason.includes("MISROUTE") || status.includes("MISROUTE")) {
      category = "MISROUTED";
      severity = "HIGH";
      action = "ESCALATE_TO_CARRIER";
    } else if (status.includes("MISSED") || reason.includes("MISSED") || status.includes("DELIVERY_EXCEPTION")) {
      category = "DELIVERY_EXCEPTION";
      severity = "MEDIUM";
      action = "CONTACT_CARRIER";
    } else if (has(input, "HELD")) {
      category = "HELD";
      severity = "MEDIUM";
      action = "CONTACT_CARRIER";
    } else if (status.includes("WEATHER") || reason.includes("WEATHER")) {
      category = "WEATHER_DELAY";
      severity = "LOW";
      action = "MONITOR";
    } else if (has(input, "LATE_VS_PROMISE")) {
      category = "LATE_DELIVERY";
      severity = "MEDIUM";
      action = "NOTIFY_CUSTOMER";
    } else if (has(input, "AT_RISK")) {
      category = "LATE_DELIVERY";
      severity = "LOW";
      action = "MONITOR";
    } else if (has(input, "CARRIER_EXCEPTION")) {
      category = "DELIVERY_EXCEPTION";
      severity = "MEDIUM";
      action = "CONTACT_CARRIER";
    } else {
      category = "DATA_QUALITY";
      severity = "LOW";
      action = "MANUAL_REVIEW";
    }

    // Data-integrity dominant, or we never got trustworthy enrichment: route to a human and
    // do not fire an automated escalation on data we don't believe.
    const integrityOnly = input.triggerFlags.every((f) => f.reason === "DATA_INTEGRITY");
    if (integrityOnly) {
      category = "DATA_QUALITY";
      severity = "MEDIUM";
      action = "MANUAL_REVIEW";
    } else if (lowTrust && action === "ESCALATE_TO_CARRIER") {
      action = "MANUAL_REVIEW";
      severity = severity === "HIGH" ? "HIGH" : "MEDIUM";
    }

    return {
      category,
      severity,
      recommendedAction: action,
      rationale: buildRationale(input, category),
      confidence: lowTrust ? "LOW" : input.enrichment.trust === "DEGRADED" ? "MEDIUM" : "HIGH",
    };
  }
}

/** Assemble a grounded rationale from the actual signals — never generic boilerplate. */
function buildRationale(input: ClassifierInput, category: Category): string {
  const bits: string[] = [];
  const flagNames = input.triggerFlags.map((f) => f.reason).join(", ");
  bits.push(`Flags: ${flagNames || "none"}.`);
  if (input.enrichment.promisedDeliveryDate) {
    bits.push(`Promised ${input.enrichment.promisedDeliveryDate}, latest status ${input.latestStatus}.`);
  }
  if (input.enrichment.statusReason) bits.push(`Carrier reason: ${input.enrichment.statusReason}.`);
  bits.push(`Enrichment trust: ${input.enrichment.trust}.`);
  if (input.enrichment.trust !== "TRUSTED" && input.enrichment.trustReasons[0]) {
    bits.push(`(${input.enrichment.trustReasons[0]})`);
  }
  return `Classified ${category}. ${bits.join(" ")}`.slice(0, 590);
}
