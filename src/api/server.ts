/**
 * Small HTTP API around the agent. This is the optional "how it actually gets deployed"
 * layer: in production the ops platform would call this, not a human running a script.
 *
 * Endpoints:
 *   GET  /health                         liveness + which classifier is wired
 *   POST /triage                         run the pipeline; body may override limit/now/etc.
 *   GET  /runs                           list past run ids
 *   GET  /runs/:id                       fetch a run's report.json
 *   GET  /runs/:id/edi/:shipmentId       fetch one raw EDI 214
 *
 * /triage runs synchronously — fine for this dataset (seconds with --limit, ~2 min full).
 * In production this would enqueue a job and return 202 + a poll URL; called out in README.
 */

import express from "express";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { runTriage } from "../pipeline/runTriage.js";
import { AuthError } from "../enrich/enrich.js";

const OUT_ROOT = process.env.OUT_ROOT ?? "out";
const PORT = Number(process.env.PORT ?? 3000);

const TriageBody = z.object({
  limit: z.number().int().positive().optional(),
  stallHours: z.number().positive().optional(),
  now: z.string().optional(),
  concurrency: z.number().int().positive().max(32).optional(),
  provider: z.enum(["mock", "anthropic"]).optional(),
});

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  const cfg = loadConfig();
  res.json({ ok: true, service: "shipment-triage-agent", classifier: cfg.llm.provider });
});

app.post("/triage", async (req, res) => {
  const parsed = TriageBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid body", issues: parsed.error.issues });
    return;
  }
  const body = parsed.data;
  const cfg = loadConfig();
  if (body.provider) cfg.llm.provider = body.provider;
  if (body.stallHours != null) cfg.stallHours = body.stallHours;

  try {
    const { runId, dir, report } = await runTriage(cfg, {
      dataPath: process.env.DATA_PATH ?? "data/events.jsonl",
      outRoot: OUT_ROOT,
      concurrency: body.concurrency ?? 6,
      limit: body.limit,
      now: body.now,
    });
    res.json({ runId, artifactsDir: dir, report });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(502).json({ error: "tracking API auth failed", detail: err.message });
      return;
    }
    res.status(500).json({ error: "run failed", detail: (err as Error).message });
  }
});

app.get("/runs", (_req, res) => {
  if (!existsSync(OUT_ROOT)) {
    res.json({ runs: [] });
    return;
  }
  const runs = readdirSync(OUT_ROOT)
    .filter((d) => d.startsWith("run-"))
    .map((d) => d.slice(4))
    .sort()
    .reverse();
  res.json({ runs });
});

app.get("/runs/:id", (req, res) => {
  const file = join(OUT_ROOT, `run-${req.params.id}`, "report.json");
  if (!existsSync(file)) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.type("application/json").send(readFileSync(file, "utf8"));
});

app.get("/runs/:id/edi/:shipmentId", (req, res) => {
  const file = join(OUT_ROOT, `run-${req.params.id}`, "edi", `${req.params.shipmentId}.edi`);
  if (!existsSync(file)) {
    res.status(404).json({ error: "no EDI 214 for that shipment in this run" });
    return;
  }
  res.type("text/plain").send(readFileSync(file, "utf8"));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`shipment-triage-agent API listening on http://localhost:${PORT}`);
});
