/**
 * Real LLM classifier via the Anthropic SDK.
 *
 * Structured output is enforced with a FORCED TOOL CALL: we hand Claude a single tool whose
 * input_schema is our JSON Schema and set tool_choice to require it. The model can only
 * answer by emitting a tool call whose arguments we then validate with zod. A schema miss
 * triggers one corrective retry before we give up — no free-text parsing, ever.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Classifier } from "./provider.js";
import type { ClassifierInput } from "./input.js";
import {
  CLASSIFICATION_JSON_SCHEMA,
  ClassificationSchema,
  type Classification,
} from "./schema.js";

const SYSTEM_PROMPT = `You are a freight-operations triage analyst. You classify a single flagged shipment into a fixed schema.

Rules:
- Ground every judgement ONLY in the data provided. Never invent statuses, dates, or facts.
- The enrichment data can be degraded or untrustworthy. When trust is UNAVAILABLE/UNTRUSTWORTHY, prefer MANUAL_REVIEW and lower confidence — do not escalate on data you cannot believe.
- Use recommendedAction=ESCALATE_TO_CARRIER only for genuine carrier-fault problems that need the carrier to act (damage, lost/stalled freight, unresolved delivery exceptions).
- rationale must cite the concrete signals you used (specific statuses, dates, trust issues). One or two sentences.`;

export class AnthropicClassifier implements Classifier {
  readonly name: string;
  private client: Anthropic;

  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
    this.name = `anthropic:${model}`;
  }

  async classify(input: ClassifierInput): Promise<Classification> {
    const userContent = `Classify this shipment. Data:\n\n${JSON.stringify(input, null, 2)}`;
    let lastErr = "";

    for (let attempt = 0; attempt < 2; attempt++) {
      const correction =
        attempt === 0
          ? ""
          : `\n\nYour previous tool call failed validation: ${lastErr}. Return a corrected record_classification call.`;

      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: "record_classification",
            description: "Record the structured triage classification for the shipment.",
            input_schema: CLASSIFICATION_JSON_SCHEMA as unknown as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: "record_classification" },
        messages: [{ role: "user", content: userContent + correction }],
      });

      const toolUse = res.content.find((b) => b.type === "tool_use");
      if (!toolUse || toolUse.type !== "tool_use") {
        lastErr = "model did not emit the required tool call";
        continue;
      }
      const parsed = ClassificationSchema.safeParse(toolUse.input);
      if (parsed.success) return parsed.data;
      lastErr = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    }

    throw new Error(`Anthropic classification failed schema validation after retry: ${lastErr}`);
  }
}
