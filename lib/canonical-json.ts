function compareByCodePoint(left: string, right: string) {
  const leftCodePoints = Array.from(left);
  const rightCodePoints = Array.from(right);
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const leftCodePoint = leftCodePoints[index].codePointAt(0)!;
    const rightCodePoint = rightCodePoints[index].codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
  }

  return leftCodePoints.length - rightCodePoints.length;
}

function canonicalSerialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }

  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON does not support ${typeof value} values`);
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON does not support cyclic values");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError("Canonical JSON only supports arrays and plain objects");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError("Canonical JSON does not support sparse arrays");
        }
        entries.push(canonicalSerialize(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue).sort(compareByCodePoint);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSerialize(objectValue[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serializes JSON-compatible data with object keys ordered by Unicode code point.
 * Unsupported JSON values are rejected instead of being silently omitted.
 */
export function canonicalJson(value: unknown) {
  return canonicalSerialize(value, new Set<object>());
}

/** Computes a lowercase SHA-256 digest using the Web Crypto API. */
export async function sha256Hex(value: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
