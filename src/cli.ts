/**
 * CLI entrypoint. `npm run triage -- [flags]`
 *
 * Flags:
 *   --limit N          process only the first N flagged shipments (demo/testing)
 *   --stall-hours N    override the stalled-shipment silence window (default 36)
 *   --now ISO          override the reference clock (default: feed's latest event)
 *   --concurrency N    parallel enrichment workers (default 6)
 *   --provider NAME    mock | anthropic (overrides LLM_PROVIDER)
 *   --data PATH        events file (default data/events.jsonl)
 *   --out PATH         output root (default out/)
 *   --verbose          stream the trace to stderr as it runs
 */

import { loadConfig } from "./config.js";
import { runTriage } from "./pipeline/runTriage.js";
import { AuthError } from "./enrich/enrich.js";

interface Args {
  limit?: number;
  stallHours?: number;
  now?: string;
  concurrency: number;
  provider?: "mock" | "anthropic";
  data: string;
  out: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { concurrency: 6, data: "data/events.jsonl", out: "out", verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const val = () => argv[++i];
    switch (arg) {
      case "--limit": a.limit = Number(val()); break;
      case "--stall-hours": a.stallHours = Number(val()); break;
      case "--now": a.now = val(); break;
      case "--concurrency": a.concurrency = Number(val()); break;
      case "--provider": a.provider = val() as Args["provider"]; break;
      case "--data": a.data = val() ?? a.data; break;
      case "--out": a.out = val() ?? a.out; break;
      case "--verbose": a.verbose = true; break;
      case "--help":
        console.log("Usage: npm run triage -- [--limit N] [--stall-hours N] [--now ISO] [--concurrency N] [--provider mock|anthropic] [--data PATH] [--out PATH] [--verbose]");
        process.exit(0);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (args.provider) cfg.llm.provider = args.provider;
  if (args.stallHours != null) cfg.stallHours = args.stallHours;

  try {
    const { report, dir } = await runTriage(cfg, {
      dataPath: args.data,
      outRoot: args.out,
      concurrency: args.concurrency,
      limit: args.limit,
      now: args.now,
      verbose: args.verbose,
    });

    // Concise terminal summary — the full detail is in the written artifacts.
    console.log("");
    console.log(`Run ${report.runId} · classifier=${report.classifier} · clock=${report.clock}`);
    console.log(`Feed:        ${report.feed.events} events, ${report.feed.shipments} shipments, ${report.feed.parseErrors} parse errors`);
    console.log(`Flagged:     ${report.trigger.flagged} (skipped ${report.trigger.skipped})`);
    console.log(`Enrichment:  trust ${JSON.stringify(report.enrichment.trustCounts)}`);
    console.log(`             API outcomes ${JSON.stringify(report.enrichment.apiOutcomeCounts)}`);
    console.log(`Actions:     ${JSON.stringify(report.classification.actionCounts)}`);
    console.log(`Escalations: ${report.escalations.count} EDI 214 → ${dir}/edi/`);
    if (report.classification.failures) console.log(`⚠️  ${report.classification.failures} classification failures — see trace.jsonl`);
    console.log(`Artifacts:   ${dir}`);
  } catch (err) {
    if (err instanceof AuthError) {
      console.error(`\n✖ Auth failed: ${err.message}\n  Check TRACKING_API_KEY in .env.`);
      process.exit(2);
    }
    console.error(`\n✖ Run failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
