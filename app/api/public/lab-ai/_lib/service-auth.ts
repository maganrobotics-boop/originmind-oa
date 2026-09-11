export const PUBLIC_LAB_AI_SERVICE_TOKEN_HEADER = "x-originmind-public-lab-ai-service-token";
export const PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type PublicLabAiAuthorization = "authorized" | "unauthorized" | "not_configured";

function fixedLengthEqual(left: string, right: string): boolean {
  if (left.length !== 43 || right.length !== 43) return false;
  let difference = 0;
  for (let index = 0; index < 43; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function authorizePublicLabAiRequest(request: Request, configuredToken: unknown): PublicLabAiAuthorization {
  if (request.headers.has("cookie") || request.headers.has("authorization")) return "unauthorized";
  const presentedToken = request.headers.get(PUBLIC_LAB_AI_SERVICE_TOKEN_HEADER) ?? "";
  if (!PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(presentedToken)) return "unauthorized";
  if (typeof configuredToken !== "string" || !PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(configuredToken)) return "not_configured";
  return fixedLengthEqual(presentedToken, configuredToken) ? "authorized" : "unauthorized";
}
