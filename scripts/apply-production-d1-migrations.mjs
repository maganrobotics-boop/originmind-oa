import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { REVIEWED_PRODUCTION_MIGRATIONS } from "../lib/production-release.mjs";

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || options[key.slice(2)]) throw new Error("Invalid migration apply arguments");
    options[key.slice(2)] = value;
  }
  const allowed = ["state", "migrations-dir", "config", "wrangler"];
  if (allowed.some((key) => !options[key]) || Object.keys(options).some((key) => !allowed.includes(key))) {
    throw new Error("Usage: apply-production-d1-migrations.mjs --state pending-0031-... --migrations-dir <dir> --config <wrangler.json> --wrangler <path>");
  }
  return options;
}

function pendingNames(state) {
  if (!/^pending-\d{4}(?:-\d{4})*$/u.test(state)) throw new Error("Production migration state is not pending");
  const requested = state.slice("pending-".length).split("-");
  const reviewed = Object.keys(REVIEWED_PRODUCTION_MIGRATIONS);
  const names = requested.map((prefix) => {
    const name = reviewed.find((candidate) => candidate.startsWith(`${prefix}_`));
    if (!name) throw new Error(`Pending migration ${prefix} is not reviewed for production`);
    return name;
  });
  if (new Set(names).size !== names.length) throw new Error("Pending migration list contains duplicates");
  const firstIndex = reviewed.indexOf(names[0]);
  if (firstIndex < 0 || JSON.stringify(names) !== JSON.stringify(reviewed.slice(firstIndex, firstIndex + names.length))) {
    throw new Error("Pending migrations must be a contiguous reviewed suffix");
  }
  return names;
}

function splitStatements(sql) {
  return sql
    .split(/^\s*-->\s*statement-breakpoint\s*$/gmu)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function sqlString(value) {
  return `'${value.replace(/'/gu, "''")}'`;
}

function runWrangler({ wrangler }, args) {
  const invokeThroughNode = process.platform === "win32" && wrangler.toLowerCase().endsWith(".mjs");
  const result = spawnSync(invokeThroughNode ? process.execPath : wrangler, invokeThroughNode ? [wrangler, ...args] : args, {
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`wrangler ${args.join(" ")} failed with exit ${result.status}`);
  const text = result.stdout.trim();
  if (!text) return;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (Array.isArray(payload) && payload.some((entry) => entry?.success === false)) {
    throw new Error("D1 statement failed");
  }
}

async function runSql(context, statement) {
  context.statementCounter += 1;
  const statementPath = join(context.tempDir, `statement-${String(context.statementCounter).padStart(4, "0")}.sql`);
  await writeFile(statementPath, `${statement.trim()}\n`);
  runWrangler(context, ["d1", "execute", "DB", "--remote", "--json", "--config", context.config, "--file", statementPath]);
}

const options = parseArguments(process.argv.slice(2));
const context = {
  wrangler: resolve(options.wrangler),
  config: resolve(options.config),
  tempDir: await mkdtemp(join(tmpdir(), "originmind-oa-d1-migration-")),
  statementCounter: 0,
};
const migrationsDir = resolve(options["migrations-dir"]);

try {
  for (const name of pendingNames(options.state)) {
    if (!/^\d{4}_[A-Za-z0-9_]+\.sql$/u.test(name)) throw new Error("Unsafe migration name");
    const sql = await readFile(resolve(migrationsDir, name), "utf8");
    const digest = createHash("sha256").update(sql).digest("hex");
    if (digest !== REVIEWED_PRODUCTION_MIGRATIONS[name]) throw new Error(`${name} does not match the reviewed SHA-256`);

    for (const statement of splitStatements(sql)) {
      await runSql(context, statement);
    }

    const id = Number(name.slice(0, 4)) + 1;
    await runSql(context, `INSERT INTO d1_migrations (id, name) VALUES (${id}, ${sqlString(name)})`);
    process.stdout.write(`Applied production migration ${name}\n`);
  }
} finally {
  await rm(context.tempDir, { recursive: true, force: true });
}
