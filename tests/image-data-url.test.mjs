import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

after(async () => {
  await vite.close();
});

const { isAllowedAvatarDataUrl } = await vite.ssrLoadModule("/lib/image-data-url.ts");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function pngDataUrl(width, height, { corruptCrc = false, truncate = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  if (corruptCrc) bytes[29] ^= 0xff;
  const value = truncate ? bytes.subarray(0, bytes.length - 3) : bytes;
  return `data:image/png;base64,${value.toString("base64")}`;
}

function jpegSegment(marker, payload) {
  const segment = Buffer.alloc(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return segment;
}

function jpegDataUrl(width, height, { truncateSof = false, omitScan = false } = {}) {
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  const sos = Buffer.from([1, 1, 0, 0, 63, 0]);
  const sofSegment = jpegSegment(0xc2, sof);
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from("JFIF\0", "ascii")),
    truncateSof ? sofSegment.subarray(0, sofSegment.length - 2) : sofSegment,
    ...(omitScan ? [] : [jpegSegment(0xda, sos), Buffer.from([0x00])]),
    Buffer.from([0xff, 0xd9]),
  ]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function webpChunk(type, payload) {
  const padding = payload.length & 1;
  const chunk = Buffer.alloc(8 + payload.length + padding);
  chunk.write(type, 0, 4, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function webpDataUrl(chunks, { declaredSizeDelta = 0, truncate = false } = {}) {
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks]);
  const bytes = Buffer.alloc(8 + body.length);
  bytes.write("RIFF", 0, 4, "ascii");
  bytes.writeUInt32LE(body.length + declaredSizeDelta, 4);
  body.copy(bytes, 8);
  const value = truncate ? bytes.subarray(0, bytes.length - 1) : bytes;
  return `data:image/webp;base64,${value.toString("base64")}`;
}

function vp8Payload(width, height) {
  const payload = Buffer.alloc(10);
  payload[0] = 0x10;
  payload.set([0x9d, 0x01, 0x2a], 3);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return payload;
}

function vp8lPayload(width, height) {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  payload.writeUInt32LE(bits >>> 0, 1);
  return payload;
}

function vp8xPayload(width, height) {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return payload;
}

test("avatar PNG validates a complete header and bounded dimensions", () => {
  assert.equal(isAllowedAvatarDataUrl(pngDataUrl(512, 512)), true);
  assert.equal(isAllowedAvatarDataUrl(pngDataUrl(0, 512)), false);
  assert.equal(isAllowedAvatarDataUrl(pngDataUrl(2049, 1)), false);
  assert.equal(isAllowedAvatarDataUrl(pngDataUrl(2001, 2000)), false);
  assert.equal(isAllowedAvatarDataUrl(pngDataUrl(512, 512, { corruptCrc: true })), false);
  assert.equal(isAllowedAvatarDataUrl(pngDataUrl(512, 512, { truncate: true })), false);
});

test("avatar JPEG traverses segments to SOF and rejects incomplete headers", () => {
  assert.equal(isAllowedAvatarDataUrl(jpegDataUrl(640, 480)), true);
  assert.equal(isAllowedAvatarDataUrl(jpegDataUrl(0, 480)), false);
  assert.equal(isAllowedAvatarDataUrl(jpegDataUrl(2049, 1)), false);
  assert.equal(isAllowedAvatarDataUrl(jpegDataUrl(640, 480, { truncateSof: true })), false);
  assert.equal(isAllowedAvatarDataUrl(jpegDataUrl(640, 480, { omitScan: true })), false);
});

test("avatar WebP supports VP8, VP8L, and VP8X dimension headers", () => {
  const vp8 = webpDataUrl([webpChunk("VP8 ", vp8Payload(640, 480))]);
  const vp8l = webpDataUrl([webpChunk("VP8L", vp8lPayload(320, 240))]);
  const vp8x = webpDataUrl([
    webpChunk("VP8X", vp8xPayload(1024, 768)),
    webpChunk("VP8 ", vp8Payload(1024, 768)),
  ]);
  assert.equal(isAllowedAvatarDataUrl(vp8), true);
  assert.equal(isAllowedAvatarDataUrl(vp8l), true);
  assert.equal(isAllowedAvatarDataUrl(vp8x), true);
  assert.equal(isAllowedAvatarDataUrl(webpDataUrl([webpChunk("VP8 ", vp8Payload(0, 480))])), false);
  assert.equal(isAllowedAvatarDataUrl(webpDataUrl([webpChunk("VP8L", vp8lPayload(2049, 1))])), false);
  assert.equal(isAllowedAvatarDataUrl(webpDataUrl([webpChunk("VP8X", vp8xPayload(1024, 768))])), false);
  assert.equal(isAllowedAvatarDataUrl(webpDataUrl([
    webpChunk("VP8X", vp8xPayload(1024, 768)),
    webpChunk("VP8 ", vp8Payload(640, 480)),
  ])), false);
  assert.equal(isAllowedAvatarDataUrl(webpDataUrl([
    webpChunk("VP8X", vp8xPayload(1024, 768)),
    webpChunk("VP8 ", vp8Payload(1024, 768)),
    webpChunk("VP8L", vp8lPayload(1024, 768)),
  ])), false);
  const animatedHeader = vp8xPayload(1024, 768);
  animatedHeader[0] = 0x02;
  assert.equal(isAllowedAvatarDataUrl(webpDataUrl([
    webpChunk("VP8X", animatedHeader),
    webpChunk("ANIM", Buffer.alloc(6)),
    webpChunk("ANMF", Buffer.alloc(24)),
  ])), false);
  assert.equal(isAllowedAvatarDataUrl(webpDataUrl([webpChunk("VP8 ", vp8Payload(640, 480))], { declaredSizeDelta: 2 })), false);
  assert.equal(isAllowedAvatarDataUrl(webpDataUrl([webpChunk("VP8 ", vp8Payload(640, 480))], { truncate: true })), false);
});

test("avatar MIME must match the parsed image format", () => {
  const jpeg = jpegDataUrl(320, 240);
  assert.equal(isAllowedAvatarDataUrl(jpeg), true);
  assert.equal(isAllowedAvatarDataUrl(jpeg.replace("image/jpeg", "image/png")), false);
  assert.equal(isAllowedAvatarDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), false);
});
