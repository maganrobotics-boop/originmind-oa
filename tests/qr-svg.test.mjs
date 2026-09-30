import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateQrSvg } from "../lib/qr-svg.ts";

test("OA QR renders locally as inert SVG with a four-module quiet zone", () => {
  const address = "https://oa.omindos.cn/auth/qr?id=0123456789abcdefghijklmnopqrstuvwxyz_ABCDE";
  const svg = generateQrSvg(address);
  assert.match(svg, /^<svg/u);
  assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/u);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/u);
  assert.match(svg, /<rect[^>]+fill="white"/u);
  assert.match(svg, /<path d="M24,24l6,0/u);
  assert.doesNotMatch(svg, /<script|<foreignObject|href=|\bon\w+=/iu);
  assert.doesNotMatch(svg, /oa\.omindos\.cn|auth\/qr/u);
  assert.equal(svg, generateQrSvg(address));
  assert.notEqual(svg, generateQrSvg(address.replace("ABCDE", "FGHIJ")));
});

test("QR generation rejects insecure, oversized and non-ASCII addresses", () => {
  for (const address of ["http://oa.example.test/", "https://oa.example.test/中文", "https://oa.example.test/" + "a".repeat(512)]) {
    assert.throws(() => generateQrSvg(address), /QR address is invalid/u);
  }
});

test("vendored encoder is pinned and retains the upstream MIT attribution", () => {
  const source = readFileSync(new URL("../vendor/qrcode-generator/qrcode.mjs", import.meta.url), "utf8");
  const provenance = readFileSync(new URL("../vendor/qrcode-generator/README.md", import.meta.url), "utf8");
  const sha = createHash("sha256").update(source).digest("hex");
  assert.ok(provenance.includes(sha));
  assert.match(source, /Copyright \(c\) 2009 Kazuhiko Arase/u);
  assert.match(source, /export default qrcode;/u);
  assert.match(readFileSync(new URL("../vendor/qrcode-generator/LICENSE", import.meta.url), "utf8"), /Permission is hereby granted/u);
});
