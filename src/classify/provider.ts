/**
 * Classifier interface + factory. The rest of the pipeline depends only on this interface,
 * so the LLM provider is swappable via one env var (LLM_PROVIDER). This is the "model /
 * provider routing" seam and what lets the whole system run without an API key.
 */

import type { Config } from "../config.js";
import type { ClassifierInput } from "./input.js";
import type { Classification } from "./schema.js";
import { MockClassifier } from "./mockProvider.js";
import { AnthropicClassifier } from "./anthropicProvider.js";

export interface Classifier {
  readonly name: string;
  classify(input: ClassifierInput): Promise<Classification>;
}

export function makeClassifier(cfg: Config): Classifier {
  if (cfg.llm.provider === "anthropic") {
    if (!cfg.llm.anthropicApiKey) {
      throw new Error(
        "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty. Set it in .env, or use LLM_PROVIDER=mock.",
      );
    }
    return new AnthropicClassifier(cfg.llm.anthropicApiKey, cfg.llm.model);
  }
  return new MockClassifier();
}
