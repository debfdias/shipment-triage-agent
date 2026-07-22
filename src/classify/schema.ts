/**
 * The structured-output contract for the LLM decision step.
 *
 * Enums are defined ONCE here and reused to build (a) the zod validator every classifier
 * output must pass, and (b) the JSON Schema handed to Claude as a forced tool call. One
 * source of truth means the model literally cannot be asked for a value we won't accept.
 */

import { z } from "zod";

export const CATEGORIES = [
  "LOST_OR_STALLED",
  "LATE_DELIVERY",
  "DAMAGED",
  "DELIVERY_EXCEPTION",
  "HELD",
  "MISROUTED",
  "DATA_QUALITY",
  "WEATHER_DELAY",
] as const;

export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const ACTIONS = [
  "MONITOR",
  "CONTACT_CARRIER",
  "ESCALATE_TO_CARRIER", // the only action that produces an EDI 214
  "NOTIFY_CUSTOMER",
  "MANUAL_REVIEW",
] as const;

export const CONFIDENCE = ["LOW", "MEDIUM", "HIGH"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Action = (typeof ACTIONS)[number];
export type Confidence = (typeof CONFIDENCE)[number];

export const ClassificationSchema = z.object({
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  recommendedAction: z.enum(ACTIONS),
  /** One or two sentences grounded in THIS shipment's data — must cite concrete signals. */
  rationale: z.string().min(10).max(600),
  /** The model's own confidence, given the (often degraded) data it was handed. */
  confidence: z.enum(CONFIDENCE),
});

export type Classification = z.infer<typeof ClassificationSchema>;

/** JSON Schema for the Anthropic forced tool call — derived from the same enums. */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CATEGORIES] },
    severity: { type: "string", enum: [...SEVERITIES] },
    recommendedAction: { type: "string", enum: [...ACTIONS] },
    rationale: {
      type: "string",
      description:
        "One or two sentences grounded in the shipment's actual data. Cite concrete signals (statuses, dates, trust issues). Do not invent facts.",
    },
    confidence: { type: "string", enum: [...CONFIDENCE] },
  },
  required: ["category", "severity", "recommendedAction", "rationale", "confidence"],
  additionalProperties: false,
} as const;
