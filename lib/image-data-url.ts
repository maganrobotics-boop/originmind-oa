const MAX_AVATAR_BYTES = 70 * 1024;
const MAX_AVATAR_DATA_URL_LENGTH = 100_000;
const MAX_AVATAR_SIDE = 2_048;
const MAX_AVATAR_PIXELS = 4_000_000;

type ImageDimensions = { width: number; height: number };

function hasBytes(bytes: Uint8Array, offset: number, length: number) {
  return offset >= 0 && length >= 0 && offset <= bytes.length - length;
}

function asciiEquals(bytes: Uint8Array, offset: number, value: string) {
  if (!hasBytes(bytes, offset, value.length)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function readUint16Be(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24Le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32Be(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function readUint32Le(bytes: Uint8Array, offset: number) {
  return (bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + (bytes[offset + 3] * 0x1000000)) >>> 0;
}

function hasSafeAvatarDimensions(dimensions: ImageDimensions | null): dimensions is ImageDimensions {
  if (!dimensions) return false;
  const { width, height } = dimensions;
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= MAX_AVATAR_SIDE
    && height <= MAX_AVATAR_SIDE
    && width * height <= MAX_AVATAR_PIXELS;
}

function pngCrc32(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 45 || signature.some((value, index) => bytes[index] !== value)) return null;

  let offset = 8;
  let dimensions: ImageDimensions | null = null;
  let seenIdat = false;
  let seenIend = false;
  while (offset < bytes.length) {
    if (!hasBytes(bytes, offset, 12)) return null;
    const length = readUint32Be(bytes, offset);
    if (length > bytes.length - offset - 12) return null;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + 4;
    if (pngCrc32(bytes, offset + 4, dataEnd) !== readUint32Be(bytes, dataEnd)) return null;

    const isIhdr = asciiEquals(bytes, offset + 4, "IHDR");
    const isIdat = asciiEquals(bytes, offset + 4, "IDAT");
    const isIend = asciiEquals(bytes, offset + 4, "IEND");
    if (!dimensions) {
      if (!isIhdr || offset !== 8 || length !== 13) return null;
      const width = readUint32Be(bytes, dataOffset);
      const height = readUint32Be(bytes, dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8];
      const colorType = bytes[dataOffset + 9];
      const validDepths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!validDepths[colorType]?.includes(bitDepth)
        || bytes[dataOffset + 10] !== 0
        || bytes[dataOffset + 11] !== 0
        || (bytes[dataOffset + 12] !== 0 && bytes[dataOffset + 12] !== 1)) return null;
      dimensions = { width, height };
    } else if (isIhdr) {
      return null;
    }

    if (isIdat) seenIdat = true;
    if (isIend) {
      if (length !== 0 || !seenIdat || chunkEnd !== bytes.length) return null;
      seenIend = true;
    }
    if (seenIend && chunkEnd !== bytes.length) return null;
    offset = chunkEnd;
  }
  return seenIend ? dimensions : null;
}

function isJpegSof(marker: number) {
  return marker >= 0xc0
    && marker <= 0xcf
    && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 16
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff
    || bytes[bytes.length - 1] !== 0xd9) return null;

  let offset = 2;
  let dimensions: ImageDimensions | null = null;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length - 2 && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length - 2) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (!hasBytes(bytes, offset, 2)) return null;
    const length = readUint16Be(bytes, offset);
    if (length < 2 || length > bytes.length - offset) return null;
    const segmentEnd = offset + length;

    if (isJpegSof(marker)) {
      if (dimensions || length < 11 || !hasBytes(bytes, offset, 8)) return null;
      const precision = bytes[offset + 2];
      const height = readUint16Be(bytes, offset + 3);
      const width = readUint16Be(bytes, offset + 5);
      const componentCount = bytes[offset + 7];
      if ((precision !== 8 && precision !== 12)
        || componentCount < 1
        || componentCount > 4
        || length !== 8 + (3 * componentCount)) return null;
      dimensions = { width, height };
    }

    if (marker === 0xda) {
      if (!dimensions || length < 8) return null;
      const componentCount = bytes[offset + 2];
      if (componentCount < 1 || componentCount > 4 || length !== 6 + (2 * componentCount)) return null;
      return segmentEnd < bytes.length - 2 ? dimensions : null;
    }
    offset = segmentEnd;
  }
  return null;
}

function vp8Dimensions(bytes: Uint8Array, offset: number, length: number): ImageDimensions | null {
  if (length < 10
    || !hasBytes(bytes, offset, length)
    || (bytes[offset] & 1) !== 0
    || (bytes[offset] & 0x10) === 0
    || !asciiEquals(bytes, offset + 3, "\u009d\u0001*")) return null;
  return {
    width: readUint16Le(bytes, offset + 6) & 0x3fff,
    height: readUint16Le(bytes, offset + 8) & 0x3fff,
  };
}

function vp8lDimensions(bytes: Uint8Array, offset: number, length: number): ImageDimensions | null {
  if (length < 5 || !hasBytes(bytes, offset, length) || bytes[offset] !== 0x2f) return null;
  const bits = readUint32Le(bytes, offset + 1);
  if ((bits >>> 29) !== 0) return null;
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
}

function vp8xDimensions(bytes: Uint8Array, offset: number, length: number): ImageDimensions | null {
  if (length !== 10
    || !hasBytes(bytes, offset, length)
    || (bytes[offset] & 0xc1) !== 0
    || bytes[offset + 1] !== 0
    || bytes[offset + 2] !== 0
    || bytes[offset + 3] !== 0) return null;
  return {
    width: readUint24Le(bytes, offset + 4) + 1,
    height: readUint24Le(bytes, offset + 7) + 1,
  };
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 26
    || !asciiEquals(bytes, 0, "RIFF")
    || !asciiEquals(bytes, 8, "WEBP")
    || readUint32Le(bytes, 4) !== bytes.length - 8) return null;

  let offset = 12;
  let dimensions: ImageDimensions | null = null;
  let isExtended = false;
  let imageDataCount = 0;
  while (offset < bytes.length) {
    if (!hasBytes(bytes, offset, 8)) return null;
    const chunkLength = readUint32Le(bytes, offset + 4);
    if (chunkLength > bytes.length - offset - 8) return null;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    const paddedEnd = dataEnd + (chunkLength & 1);
    if (paddedEnd > bytes.length || ((chunkLength & 1) !== 0 && bytes[dataEnd] !== 0)) return null;

    if (offset === 12) {
      if (asciiEquals(bytes, offset, "VP8 ")) dimensions = vp8Dimensions(bytes, dataOffset, chunkLength);
      else if (asciiEquals(bytes, offset, "VP8L")) dimensions = vp8lDimensions(bytes, dataOffset, chunkLength);
      else if (asciiEquals(bytes, offset, "VP8X")) {
        dimensions = vp8xDimensions(bytes, dataOffset, chunkLength);
        isExtended = true;
        if ((bytes[dataOffset] & 0x02) !== 0) return null;
      } else return null;
      if (!dimensions) return null;
      imageDataCount = isExtended ? 0 : 1;
    } else if (isExtended) {
      if (asciiEquals(bytes, offset, "VP8 ")) {
        const innerDimensions = vp8Dimensions(bytes, dataOffset, chunkLength);
        if (!hasSafeAvatarDimensions(innerDimensions)
          || !dimensions
          || innerDimensions.width !== dimensions.width
          || innerDimensions.height !== dimensions.height) return null;
        imageDataCount += 1;
      } else if (asciiEquals(bytes, offset, "VP8L")) {
        const innerDimensions = vp8lDimensions(bytes, dataOffset, chunkLength);
        if (!hasSafeAvatarDimensions(innerDimensions)
          || !dimensions
          || innerDimensions.width !== dimensions.width
          || innerDimensions.height !== dimensions.height) return null;
        imageDataCount += 1;
      } else if (asciiEquals(bytes, offset, "ANIM") || asciiEquals(bytes, offset, "ANMF")) {
        return null;
      }
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length || imageDataCount !== 1) return null;
  return dimensions;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isAllowedAvatarDataUrl(value: string) {
  if (!value) return true;
  if (value.length > MAX_AVATAR_DATA_URL_LENGTH) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return false;
  try {
    const bytes = decodeBase64(match[2]);
    if (bytes.length < 12 || bytes.length > MAX_AVATAR_BYTES) return false;
    const dimensions = match[1] === "png"
      ? pngDimensions(bytes)
      : match[1] === "jpeg"
        ? jpegDimensions(bytes)
        : webpDimensions(bytes);
    return hasSafeAvatarDimensions(dimensions);
  } catch {
    return false;
  }
}
