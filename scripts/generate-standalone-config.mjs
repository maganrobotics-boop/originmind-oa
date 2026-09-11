import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildStandaloneConfig } from "../lib/standalone-config.mjs";

const target = process.argv[2] || "";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(projectRoot, ".wrangler", "generated", `wrangler.${target}.json`);
const config = buildStandaloneConfig(target, process.env);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${outputPath}\n`);
