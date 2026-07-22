/**
 * The result of pushing one shipment through the whole pipeline. This is the unit the
 * observability layer reports on and the orchestrator collects.
 */

import type { ShipmentException } from "../trigger/rules.js";
import type { EnrichmentResult } from "../enrich/enrich.js";
import type { Classification } from "../classify/schema.js";
import type { Escalation } from "../escalate/edi214.js";

export interface ProcessedShipment {
  exception: ShipmentException;
  enrichment: EnrichmentResult;
  /** null if classification failed (e.g. the LLM call errored). */
  classification: Classification | null;
  classificationError?: string;
  /** Present only when the classifier's action was ESCALATE_TO_CARRIER. */
  escalation: Escalation | null;
}
