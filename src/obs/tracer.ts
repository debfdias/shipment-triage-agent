/**
 * Structured tracer. Every meaningful step appends a timestamped, machine-readable event.
 * The trace is written as JSONL (one event per line) so a run can be replayed, grepped, or
 * fed to a log tool — the "someone else could debug a bad result" requirement.
 *
 * It doubles as a light console logger during a run (toggle with `console`).
 */

export type Level = "info" | "warn" | "error";

export interface TraceEvent {
  t: string; // ISO wall-clock time
  runId: string;
  level: Level;
  stage: string; // ingest | trigger | enrich | classify | escalate | run
  shipmentId?: string;
  msg: string;
  data?: unknown;
}

export class Tracer {
  readonly events: TraceEvent[] = [];

  constructor(
    readonly runId: string,
    private readonly opts: { console?: boolean } = {},
  ) {}

  private push(level: Level, stage: string, msg: string, shipmentId?: string, data?: unknown) {
    const ev: TraceEvent = { t: new Date().toISOString(), runId: this.runId, level, stage, msg };
    if (shipmentId) ev.shipmentId = shipmentId;
    if (data !== undefined) ev.data = data;
    this.events.push(ev);
    if (this.opts.console) {
      const tag = level === "error" ? "ERR " : level === "warn" ? "WARN" : "INFO";
      const who = shipmentId ? ` ${shipmentId}` : "";
      // eslint-disable-next-line no-console
      console.error(`[${tag}] ${stage}${who}: ${msg}`);
    }
  }

  info(stage: string, msg: string, shipmentId?: string, data?: unknown) {
    this.push("info", stage, msg, shipmentId, data);
  }
  warn(stage: string, msg: string, shipmentId?: string, data?: unknown) {
    this.push("warn", stage, msg, shipmentId, data);
  }
  error(stage: string, msg: string, shipmentId?: string, data?: unknown) {
    this.push("error", stage, msg, shipmentId, data);
  }

  toJsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
}
