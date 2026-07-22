/**
 * Read events.jsonl into normalized events.
 *
 * Real carrier feeds contain junk lines. We record parse failures instead of crashing or
 * silently dropping them — a line we couldn't read is itself a signal worth surfacing.
 */

import { readFileSync } from "node:fs";
import type { IngestResult, NormalizedEvent, ParseError } from "../types.js";
import { normalizeEvent } from "./normalize.js";

export function loadEvents(path: string): IngestResult {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);

  const events: NormalizedEvent[] = [];
  const parseErrors: ParseError[] = [];

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return; // ignore blank lines

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      parseErrors.push({
        lineNumber: i + 1,
        rawLine: trimmed,
        message: `invalid JSON: ${(err as Error).message}`,
      });
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      parseErrors.push({ lineNumber: i + 1, rawLine: trimmed, message: "not a JSON object" });
      return;
    }

    try {
      events.push(normalizeEvent(parsed as Record<string, unknown>));
    } catch (err) {
      parseErrors.push({
        lineNumber: i + 1,
        rawLine: trimmed,
        message: `normalization failed: ${(err as Error).message}`,
      });
    }
  });

  return { events, parseErrors };
}

/** Group normalized events by shipment, each list sorted oldest → newest by timestamp. */
export function groupByShipment(events: NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const byId = new Map<string, NormalizedEvent[]>();
  for (const e of events) {
    const list = byId.get(e.shipmentId) ?? [];
    list.push(e);
    byId.set(e.shipmentId, list);
  }
  for (const list of byId.values()) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  return byId;
}
