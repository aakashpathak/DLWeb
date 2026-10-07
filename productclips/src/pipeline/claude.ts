// Thin wrapper over the Anthropic SDK: schema-validated structured output
// with retries, server-side refusal fallbacks and image inputs.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import fs from "node:fs/promises";
import sharp from "sharp";
import { resolveFile } from "../lib/store";

export const MODEL = process.env.PRODUCTCLIPS_MODEL || "claude-sonnet-5-5";
export const hasClaude = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic({ maxRetries: 3, timeout: 180_000 }));

type Block = Anthropic.Beta.Messages.BetaContentBlockParam;

/** Image block from a stored file, downscaled to keep tokens sane. */
export async function imageBlock(storagePath: string, maxSide = 1280): Promise<Block> {
  const buf = await fs.readFile(resolveFile(storagePath));
  const data = await sharp(buf).flatten({ background: "#ffffff" }).resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") } };
}

export async function structured<T extends z.ZodType>(opts: {
  schema: T; system: string; content: Block[]; effort?: "low" | "medium" | "high"; maxTokens?: number; attempts?: number;
}): Promise<z.infer<T>> {
  const attempts = opts.attempts ?? 2;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const msg = await getClient().beta.messages.parse({
        model: MODEL,
        max_tokens: opts.maxTokens ?? 8000,
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: opts.content }],
        output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(opts.schema) },
        // Route refusals to a fallback model server-side instead of failing the step.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      if (msg.stop_reason === "refusal") throw new Error("Claude declined this request.");
      if (msg.stop_reason === "max_tokens") throw new Error("Response was cut off.");
      if (msg.parsed_output == null) throw new Error("Response did not match the schema.");
      return msg.parsed_output as z.infer<T>;
    } catch (e) {
      lastErr = e;
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
