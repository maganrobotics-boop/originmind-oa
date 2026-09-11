import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateD1Bookmark } from "../lib/production-release.mjs";

if (process.argv.length !== 4) {
  throw new Error("Usage: check-production-d1-bookmark.mjs <provider-json> <new-receipt-json>");
}
const inputPath = resolve(process.argv[2]);
const receiptPath = resolve(process.argv[3]);
const bookmark = validateD1Bookmark(JSON.parse(await readFile(inputPath, "utf8")));
await writeFile(receiptPath, `${JSON.stringify({
  format: "originmind-oa-production-d1-bookmark-v1",
  capturedAt: new Date().toISOString(),
  bookmark,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
process.stdout.write("Verified the D1 Time Travel recovery bookmark.\n");