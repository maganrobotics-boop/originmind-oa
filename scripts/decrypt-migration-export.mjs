import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, decryptMigrationEnvelope, verifyFreshMigrationPayload } from "../lib/migration-export.mjs";

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Invalid arguments");
    options[key.slice(2)] = value;
  }
  return options;
}

function usage() {
  process.stderr.write("Usage: node scripts/decrypt-migration-export.mjs --input <archive> --private-key <jwk> --auth-key-file <file> --expected-origin <https-origin> --output <json>\n");
  process.exitCode = 64;
}

const worktree = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function assertResolvedOutsideWorktree(path, label) {
  const relativePath = relative(worktree, path);
  if (relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`))) throw new Error(`${label} must be outside the Git worktree`);
}

async function assertRegularFile(path, label, maximumBytes, privatePermissions = false) {
  const details = await lstat(path);
  if (!details.isFile()) throw new Error(`${label} must be a regular file`);
  assertResolvedOutsideWorktree(await realpath(path), label);
  if (details.size <= 0 || details.size > maximumBytes) throw new Error(`${label} has an unsafe size`);
  // Windows reports synthetic POSIX mode bits that do not reflect NTFS ACLs.
  // The generator still creates outside the worktree with exclusive writes;
  // enforce group/other mode bits only on platforms where they are meaningful.
  if (privatePermissions && process.platform !== "win32" && (details.mode & 0o077) !== 0) throw new Error(`${label} must not be accessible to group or other users`);
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch {
  usage();
}

if (options) {
  const required = ["input", "private-key", "auth-key-file", "expected-origin", "output"];
  if (required.some((key) => !options[key]) || Object.keys(options).some((key) => !required.includes(key))) {
    usage();
  } else {
    const inputPath = resolve(options.input);
    const privateKeyPath = resolve(options["private-key"]);
    const authKeyPath = resolve(options["auth-key-file"]);
    const outputPath = resolve(options.output);
    const outputParent = await realpath(dirname(outputPath));
    assertResolvedOutsideWorktree(resolve(outputParent, basename(outputPath)), "Decrypted output");
    if (inputPath === outputPath) throw new Error("Encrypted input and decrypted output must be different files");
    await Promise.all([
      assertRegularFile(inputPath, "Encrypted input", 9 * 1024 * 1024),
      assertRegularFile(privateKeyPath, "Private key", 16 * 1024, true),
      assertRegularFile(authKeyPath, "Authentication key", 256, true),
    ]);
    const [serializedEnvelope, serializedPrivateKey, authKey] = await Promise.all([
      readFile(inputPath, "utf8"),
      readFile(privateKeyPath, "utf8"),
      readFile(authKeyPath, "utf8"),
    ]);
    const envelope = JSON.parse(serializedEnvelope);
    const privateKey = JSON.parse(serializedPrivateKey);
    const payload = await decryptMigrationEnvelope(envelope, privateKey);
    await verifyFreshMigrationPayload(payload, {
      expectedAuthKey: authKey.trim(),
      expectedSourceOrigin: options["expected-origin"],
    });
    await writeFile(outputPath, canonicalJson(payload), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const totalRows = payload.tables.reduce((sum, table) => sum + table.rowCount, 0);
    process.stdout.write(`Verified and decrypted ${payload.tables.length} tables (${totalRows} rows) to ${outputPath}.\n`);
  }
}
