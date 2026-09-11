import { requiredStandaloneSecrets } from "../lib/standalone-config.mjs";

const requiredNames = [...requiredStandaloneSecrets].sort();
let input = "";
for await (const chunk of process.stdin) input += chunk;
const parsed = JSON.parse(input);
if (!Array.isArray(parsed)) throw new Error("Cloudflare staging secret list must be an array");

const names = parsed.map((entry) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.name !== "string") {
    throw new Error("Cloudflare staging secret list contains an invalid entry");
  }
  return entry.name;
}).sort();

if (new Set(names).size !== names.length || JSON.stringify(names) !== JSON.stringify(requiredNames)) {
  throw new Error(`Cloudflare staging Worker must contain exactly these secrets: ${requiredNames.join(", ")}`);
}

process.stdout.write("Required Cloudflare staging secret names are configured.\n");
