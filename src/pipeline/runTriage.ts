/**
 * The orchestrator: ingest → trigger → enrich → classify → escalate, fully traced, with
 * artifacts written to out/run-<id>/. This is the whole agent as one function.
 */

import type { Config } from "../config.js";
import { loadEvents, groupByShipment } from "../ingest/loadEvents.js";
import { triage } from "../trigger/rules.js";
import { TrackingClient } from "../enrich/trackingClient.js";
import { enrichShipment, AuthError } from "../enrich/enrich.js";
import { buildClassifierInput } from "../classify/input.js";
import { makeClassifier } from "../classify/provider.js";
import { buildEdi214 } from "../escalate/edi214.js";
import { Tracer } from "../obs/tracer.js";
import { buildReport, type RunReport } from "../obs/report.js";
import { writeRunArtifacts } from "../obs/writer.js";
import { mapWithConcurrency } from "./pool.js";
import type { ProcessedShipment } from "./types.js";

export interface RunOptions {
  dataPath: string;
  outRoot: string;
  concurrency: number;
  limit?: number;
  now?: string;
  verbose?: boolean;
}

export interface RunOutput {
  runId: string;
  dir: string;
  report: RunReport;
  processed: ProcessedShipment[];
}

/** Compact, filesystem-safe run id from an ISO timestamp: 20260722T113005Z. */
function makeRunId(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export async function runTriage(cfg: Config, opts: RunOptions): Promise<RunOutput> {
  const start = new Date();
  const runId = makeRunId(start);
  const tracer = new Tracer(runId, { console: opts.verbose });
  tracer.info("run", `starting run ${runId}`, undefined, {
    provider: cfg.llm.provider,
    stallHours: cfg.stallHours,
    concurrency: opts.concurrency,
    limit: opts.limit ?? null,
  });

  // 1. Ingest + normalize
  const ingest = loadEvents(opts.dataPath);
  tracer.info("ingest", `loaded ${ingest.events.length} events`, undefined, {
    parseErrors: ingest.parseErrors.length,
  });
  for (const pe of ingest.parseErrors) {
    tracer.warn("ingest", `parse error on line ${pe.lineNumber}: ${pe.message}`);
  }

  // 2. Trigger
  const byShipment = groupByShipment(ingest.events);
  const triaged = triage(byShipment, { stallHours: cfg.stallHours, now: opts.now });
  tracer.info("trigger", `flagged ${triaged.exceptions.length}/${triaged.total}`, undefined, {
    skipped: triaged.skipped,
    clock: triaged.now,
  });

  let queue = triaged.exceptions;
  if (opts.limit != null && opts.limit < queue.length) {
    tracer.warn("run", `--limit ${opts.limit}: processing ${opts.limit} of ${queue.length} flagged (rest skipped)`);
    queue = queue.slice(0, opts.limit);
  }

  // 3 + 4. Enrich + classify (concurrent). AuthError bubbles up to abort the run.
  const classifier = makeClassifier(cfg);
  const client = new TrackingClient(cfg.tracking);

  const partial = await mapWithConcurrency(queue, opts.concurrency, async (exc) => {
    const enrichment = await enrichShipment(client, exc, {
      maxAttempts: cfg.tracking.maxAttempts,
      backoffMs: cfg.tracking.backoffMs,
    });
    tracer.info("enrich", `trust=${enrichment.trust} attempts=${enrichment.attempts}`, exc.shipmentId, {
      outcomes: enrichment.outcomes,
      trustReasons: enrichment.trustReasons,
    });

    let classification = null;
    let classificationError: string | undefined;
    try {
      classification = await classifier.classify(buildClassifierInput(exc, enrichment));
      tracer.info(
        "classify",
        `${classification.category}/${classification.severity}/${classification.recommendedAction}`,
        exc.shipmentId,
        { confidence: classification.confidence },
      );
    } catch (err) {
      classificationError = (err as Error).message;
      tracer.error("classify", `classification failed: ${classificationError}`, exc.shipmentId);
    }

    return { exception: exc, enrichment, classification, classificationError };
  }).catch((err) => {
    if (err instanceof AuthError) {
      tracer.error("enrich", `aborting run — ${err.message}`);
    }
    throw err;
  });

  // 5. Escalate — deterministic order so control numbers are stable/monotonic.
  const processed: ProcessedShipment[] = [];
  let control = 1;
  for (const p of partial) {
    let escalation = null;
    if (p.classification && p.classification.recommendedAction === "ESCALATE_TO_CARRIER") {
      escalation = buildEdi214(p.exception, p.enrichment, p.classification, {
        senderId: "SHIPTRIAGE",
        controlNumber: control++,
        now: new Date(),
      });
      tracer.info("escalate", `EDI 214 #${escalation.controlNumber} AT7 ${escalation.at7.statusCode}/${escalation.at7.reasonCode}`, p.exception.shipmentId);
    }
    processed.push({ ...p, escalation });
  }

  const finish = new Date();
  const report = buildReport({
    runId,
    startedAt: start.toISOString(),
    finishedAt: finish.toISOString(),
    clock: triaged.now,
    classifier: classifier.name,
    ingest,
    triage: triaged,
    processed,
  });

  tracer.info(
    "run",
    `done — ${report.escalations.count} escalations, ${report.classification.failures} classify failures in ${report.durationMs}ms`,
  );

  const { dir } = writeRunArtifacts({
    outRoot: opts.outRoot,
    runId,
    tracer,
    report,
    processed,
    parseErrors: ingest.parseErrors,
  });

  return { runId, dir, report, processed };
}
