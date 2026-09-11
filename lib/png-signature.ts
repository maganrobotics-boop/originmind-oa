const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function uint32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

/**
 * Browser canvas encoders may add color-metadata chunks that differ by browser
 * version. They do not contribute to the handwritten pixels, so remove every
 * ancillary chunk before submitting the evidence. Critical PNG chunks and
 * their original CRCs remain byte-for-byte unchanged and are still fully
 * validated by the server.
 */
export function canonicalizeSignaturePngDataUrl(value: string) {
  if (!value.startsWith(PNG_DATA_URL_PREFIX)) return value;
  try {
    const binary = atob(value.slice(PNG_DATA_URL_PREFIX.length));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (PNG_SIGNATURE.some((expected, index) => bytes[index] !== expected)) return value;
    const kept: Uint8Array[] = [bytes.slice(0, PNG_SIGNATURE.length)];
    let offset: number = PNG_SIGNATURE.length;
    let sawEnd = false;
    while (offset + 12 <= bytes.length) {
      const length = uint32(bytes, offset);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > bytes.length) return value;
      const typeFirstByte = bytes[offset + 4];
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      if (!/^[A-Za-z]{4}$/u.test(type)) return value;
      if ((typeFirstByte & 0x20) === 0) kept.push(bytes.slice(offset, chunkEnd));
      offset = chunkEnd;
      if (type === "IEND") {
        sawEnd = true;
        break;
      }
    }
    if (!sawEnd || offset !== bytes.length) return value;
    const totalLength = kept.reduce((total, chunk) => total + chunk.length, 0);
    const canonical = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const chunk of kept) {
      canonical.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }
    let canonicalBinary = "";
    for (let index = 0; index < canonical.length; index += 0x8000) {
      canonicalBinary += String.fromCharCode(...canonical.subarray(index, index + 0x8000));
    }
    return `${PNG_DATA_URL_PREFIX}${btoa(canonicalBinary)}`;
  } catch {
    return value;
  }
}
