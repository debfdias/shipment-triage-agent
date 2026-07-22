/**
 * Central config. Reads .env (if present) then process.env, with defaults drawn from the
 * brief so the project runs out-of-the-box. Secrets live only in .env (gitignored).
 */

import { existsSync } from "node:fs";

// Node 20.12+ can load a .env with no dependency. Guarded so a missing file is harmless.
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch {
  /* older Node or unreadable file — fall back to process.env only */
}

export type LlmProvider = "mock" | "anthropic";

export interface Config {
  tracking: { baseUrl: string; apiKey: string; timeoutMs: number; maxAttempts: number; backoffMs: number };
  llm: { provider: LlmProvider; anthropicApiKey: string; model: string };
  stallHours: number;
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(): Config {
  const provider = env("LLM_PROVIDER", "mock") as LlmProvider;
  return {
    tracking: {
      baseUrl: env("TRACKING_API_BASE", "https://xteam-ho-2920.wasmer.app"),
      apiKey: env("TRACKING_API_KEY", "xt2920-k7q2m9wz"),
      timeoutMs: Number(env("TRACKING_TIMEOUT_MS", "6000")),
      maxAttempts: Number(env("TRACKING_MAX_ATTEMPTS", "4")),
      backoffMs: Number(env("TRACKING_BACKOFF_MS", "300")),
    },
    llm: {
      provider: provider === "anthropic" ? "anthropic" : "mock",
      anthropicApiKey: env("ANTHROPIC_API_KEY", ""),
      model: env("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
    },
    stallHours: Number(env("STALL_HOURS", "36")),
  };
}
