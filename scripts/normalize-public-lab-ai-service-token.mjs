#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const PUBLIC_LAB_AI_SERVICE_TOKEN_CONTEXT = "originmind-public-lab-ai-service-token-v1\0";

export function normalizePublicLabAiServiceToken(rawValue, cloudflareApiToken) {
  if (typeof rawValue !== "string" || rawValue.length > 4_096) {
    throw new Error("PUBLIC_LAB_AI_SERVICE_TOKEN is missing or invalid.");
  }
  const value = rawValue.trim();
  if (!value) throw new Error("PUBLIC_LAB_AI_SERVICE_TOKEN is required.");
  if (PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(value)) return value;
  if (typeof cloudflareApiToken !== "string" || !cloudflareApiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN is required to normalize the service token.");
  }
  // The OA and Chat workflows share the same protected environment. This
  // domain-separated fallback gives both releases the same high-entropy token
  // when a mobile clipboard changes the stored seed's representation.
  return createHmac("sha256", cloudflareApiToken)
    .update(PUBLIC_LAB_AI_SERVICE_TOKEN_CONTEXT, "utf8")
    .update(value, "utf8")
    .digest("base64url");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(normalizePublicLabAiServiceToken(
      process.env.PUBLIC_LAB_AI_SERVICE_TOKEN,
      process.env.CLOUDFLARE_API_TOKEN,
    ));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to normalize the service token.");
    process.exitCode = 64;
  }
}
