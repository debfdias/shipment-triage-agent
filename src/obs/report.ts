/**
 * Build a run report from the processed shipments — the human-facing "what happened".
 * Produces a structured object (report.json) and a markdown rendering (report.md).
 */

import type { IngestResult } from "../types.js";
import type { TriageResult } from "../trigger/rules.js";
import type { ProcessedShipment } from "../pipeline/types.js";

function tally<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  clock: string;
  classifier: string;
  feed: { events: number; shipments: number; parseErrors: number };
  trigger: { flagged: number; skipped: number; reasonCounts: Record<string, number> };
  enrichment: { trustCounts: Record<string, number>; apiOutcomeCounts: Record<string, number>; totalAttempts: number };
  classification: {
    categoryCounts: Record<string, number>;
    severityCounts: Record<string, number>;
    actionCounts: Record<string, number>;
    failures: number;
  };
  escalations: { count: number; byCategory: Record<string, number> };
  shipments: ShipmentRow[];
}

export interface ShipmentRow {
  shipmentId: string;
  carrier: string;
  latestStatus: string;
  flags: string[];
  trust: string;
  attempts: number;
  apiOutcomes: string[];
  category: string | null;
  severity: string | null;
  action: string | null;
  confidence: string | null;
  escalated: boolean;
  at7: string | null;
  rationale: string | null;
}

export function buildReport(args: {
  runId: string;
  startedAt: string;
  finishedAt: string;
  clock: string;
  classifier: string;
  ingest: IngestResult;
  triage: TriageResult;
  processed: ProcessedShipment[];
}): RunReport {
  const { processed } = args;

  const shipments: ShipmentRow[] = processed.map((p) => ({
    shipmentId: p.exception.shipmentId,
    carrier: p.exception.carrier,
    latestStatus: p.exception.latest.status,
    flags: p.exception.flags.map((f) => f.reason),
    trust: p.enrichment.trust,
    attempts: p.enrichment.attempts,
    apiOutcomes: p.enrichment.outcomes,
    category: p.classification?.category ?? null,
    severity: p.classification?.severity ?? null,
    action: p.classification?.recommendedAction ?? null,
    confidence: p.classification?.confidence ?? null,
    escalated: p.escalation != null,
    at7: p.escalation ? `${p.escalation.at7.statusCode}/${p.escalation.at7.reasonCode}` : null,
    rationale: p.classification?.rationale ?? null,
  }));

  const escalated = processed.filter((p) => p.escalation);

  return {
    runId: args.runId,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    durationMs: new Date(args.finishedAt).getTime() - new Date(args.startedAt).getTime(),
    clock: args.clock,
    classifier: args.classifier,
    feed: {
      events: args.ingest.events.length,
      shipments: args.triage.total,
      parseErrors: args.ingest.parseErrors.length,
    },
    trigger: {
      flagged: args.triage.exceptions.length,
      skipped: args.triage.skipped,
      reasonCounts: tally(args.triage.exceptions.flatMap((e) => e.flags.map((f) => f.reason))),
    },
    enrichment: {
      trustCounts: tally(processed.map((p) => p.enrichment.trust)),
      apiOutcomeCounts: tally(processed.flatMap((p) => p.enrichment.outcomes)),
      totalAttempts: processed.reduce((s, p) => s + p.enrichment.attempts, 0),
    },
    classification: {
      categoryCounts: tally(shipments.map((s) => s.category).filter(Boolean) as string[]),
      severityCounts: tally(shipments.map((s) => s.severity).filter(Boolean) as string[]),
      actionCounts: tally(shipments.map((s) => s.action).filter(Boolean) as string[]),
      failures: processed.filter((p) => p.classificationError).length,
    },
    escalations: {
      count: escalated.length,
      byCategory: tally(escalated.map((p) => p.classification!.category)),
    },
    shipments,
  };
}

// --- Markdown rendering -----------------------------------------------------------------

function kv(obj: Record<string, number>): string {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "_none_";
  return entries.map(([k, v]) => `${k}: ${v}`).join(" · ");
}

export function renderMarkdown(r: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Triage run ${r.runId}`);
  lines.push("");
  lines.push(`- **Started:** ${r.startedAt} → **finished:** ${r.finishedAt} (${r.durationMs} ms)`);
  lines.push(`- **Feed clock:** ${r.clock}`);
  lines.push(`- **Classifier:** ${r.classifier}`);
  lines.push("");
  lines.push(`## Feed`);
  lines.push(`${r.feed.events} events · ${r.feed.shipments} shipments · ${r.feed.parseErrors} parse errors`);
  lines.push("");
  lines.push(`## Trigger`);
  lines.push(`**${r.trigger.flagged}** flagged · ${r.trigger.skipped} skipped as noise`);
  lines.push(`Reasons — ${kv(r.trigger.reasonCounts)}`);
  lines.push("");
  lines.push(`## Enrichment (what the API threw)`);
  lines.push(`Trust — ${kv(r.enrichment.trustCounts)}`);
  lines.push(`API outcomes — ${kv(r.enrichment.apiOutcomeCounts)}`);
  lines.push(`Total HTTP attempts — ${r.enrichment.totalAttempts}`);
  lines.push("");
  lines.push(`## Classification`);
  lines.push(`Category — ${kv(r.classification.categoryCounts)}`);
  lines.push(`Severity — ${kv(r.classification.severityCounts)}`);
  lines.push(`Action — ${kv(r.classification.actionCounts)}`);
  if (r.classification.failures) lines.push(`⚠️ Classification failures — ${r.classification.failures}`);
  lines.push("");
  lines.push(`## Escalations (EDI 214 emitted)`);
  lines.push(`**${r.escalations.count}** · ${kv(r.escalations.byCategory)}`);
  lines.push("");
  lines.push(`## Shipments`);
  lines.push("");
  lines.push(`| Shipment | Carrier | Status | Flags | Trust | Try | Category | Sev | Action | AT7 |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of r.shipments) {
    lines.push(
      `| ${s.shipmentId} | ${s.carrier} | ${s.latestStatus} | ${s.flags.join(", ")} | ${s.trust} | ${s.attempts} | ${s.category ?? "—"} | ${s.severity ?? "—"} | ${s.action ?? "—"}${s.escalated ? " 📤" : ""} | ${s.at7 ?? "—"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
