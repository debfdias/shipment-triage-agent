/**
 * Low-level HTTP client for the tracking API. One job: make a single request and report,
 * without interpretation, what came back. Retry policy and trust scoring live one layer up
 * (enrich.ts) so this stays a thin, testable transport.
 */

export interface TrackingClientConfig {
  baseUrl: string;
  apiKey: string;
  /** Per-attempt timeout in ms (the API's own upstream times out around 5s). */
  timeoutMs: number;
}

/** Raw outcome of one HTTP attempt — no judgement about whether the body is any good. */
export type FetchOutcome =
  | { kind: "http"; status: number; body: unknown; rawText: string }
  | { kind: "invalid_json"; status: number; rawText: string }
  | { kind: "timeout" }
  | { kind: "network_error"; message: string };

/** Sentinel thrown for 401 so the orchestrator can abort the whole run immediately. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class TrackingClient {
  constructor(private readonly cfg: TrackingClientConfig) {}

  /** One attempt. Never throws except AuthError (401 = misconfiguration, unrecoverable). */
  async fetchOnce(shipmentId: string): Promise<FetchOutcome> {
    const url = `${this.cfg.baseUrl}/tracking/${encodeURIComponent(shipmentId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "x-api-key": this.cfg.apiKey, accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") return { kind: "timeout" };
      return { kind: "network_error", message: (err as Error).message };
    }
    clearTimeout(timer);

    const rawText = await res.text();

    // 401 is not a per-shipment problem — the key is wrong. Fail loud, fail once.
    if (res.status === 401) {
      throw new AuthError(`tracking API rejected the API key (401): ${rawText.slice(0, 200)}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      return { kind: "invalid_json", status: res.status, rawText };
    }
    return { kind: "http", status: res.status, body, rawText };
  }
}
