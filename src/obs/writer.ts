/**
 * Persist a run's artifacts to out/run-<runId>/:
 *   trace.jsonl          — the full structured event trace
 *   report.json          — machine-readable run report
 *   report.md            — human-readable run summary
 *   edi/<shipmentId>.edi — one EDI 214 per escalated shipment
 *   parse-errors.json    — any unreadable feed lines (only if present)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tracer } from "./tracer.js";
import { renderMarkdown, type RunReport } from "./report.js";
import type { ProcessedShipment } from "../pipeline/types.js";
import type { ParseError } from "../types.js";

export interface WriteResult {
  dir: string;
  ediCount: number;
}

export function writeRunArtifacts(args: {
  outRoot: string;
  runId: string;
  tracer: Tracer;
  report: RunReport;
  processed: ProcessedShipment[];
  parseErrors: ParseError[];
}): WriteResult {
  const dir = join(args.outRoot, `run-${args.runId}`);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, "trace.jsonl"), args.tracer.toJsonl());
  writeFileSync(join(dir, "report.json"), JSON.stringify(args.report, null, 2));
  writeFileSync(join(dir, "report.md"), renderMarkdown(args.report));

  if (args.parseErrors.length > 0) {
    writeFileSync(join(dir, "parse-errors.json"), JSON.stringify(args.parseErrors, null, 2));
  }

  const escalations = args.processed.filter((p) => p.escalation);
  if (escalations.length > 0) {
    const ediDir = join(dir, "edi");
    mkdirSync(ediDir, { recursive: true });
    for (const p of escalations) {
      writeFileSync(join(ediDir, `${p.exception.shipmentId}.edi`), p.escalation!.edi214 + "\n");
    }
  }

  return { dir, ediCount: escalations.length };
}
