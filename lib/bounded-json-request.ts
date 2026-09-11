export type BoundedJsonFailureReason =
  | "too_large"
  | "empty_body"
  | "stream_error"
  | "invalid_utf8"
  | "invalid_json"
  | "non_object";

export type BoundedJsonObjectResult =
  | { ok: true; value: Record<string, unknown>; byteLength: number }
  | { ok: false; reason: BoundedJsonFailureReason };

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Cancellation is best-effort; the bounded reader has already stopped consuming.
  }
}

/**
 * Read a JSON object without ever buffering more than maxBytes of request data.
 * The byte limit is enforced on the stream itself, so it does not depend on a
 * trustworthy Content-Length header.
 */
export async function readBoundedJsonObject(request: Request, maxBytes: number): Promise<BoundedJsonObjectResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");

  const declaredLengthHeader = request.headers.get("content-length");
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await cancelBody(request.body);
      return { ok: false, reason: "too_large" };
    }
  }

  if (!request.body) return { ok: false, reason: "empty_body" };

  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - byteLength) {
        try {
          await reader.cancel();
        } catch {
          // The limit result is authoritative even if the runtime cannot signal cancellation upstream.
        }
        return { ok: false, reason: "too_large" };
      }
      bytes.set(value, byteLength);
      byteLength += value.byteLength;
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Ignore a secondary cancellation failure after a stream error.
    }
    return { ok: false, reason: "stream_error" };
  } finally {
    reader.releaseLock();
  }

  if (byteLength === 0) return { ok: false, reason: "empty_body" };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, byteLength));
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "non_object" };
  return { ok: true, value: parsed as Record<string, unknown>, byteLength };
}
