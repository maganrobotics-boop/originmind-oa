import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = await realpath(resolve(fileURLToPath(new URL("..", import.meta.url))));
const requiredNames = ["FEISHU_LOGIN_APP_SECRET", "GITHUB_OAUTH_CLIENT_SECRET"];
const inputPath = process.argv[2];
if (!inputPath) throw new Error("OA_STAGING_SECRETS_FILE must name a private JSON file outside the Git worktree");

const requestedPath = resolve(inputPath);
const details = await lstat(requestedPath);
if (!details.isFile()) throw new Error("Staging secrets input must be a regular file, not a symlink");
const resolvedPath = await realpath(requestedPath);
const relativePath = relative(projectRoot, resolvedPath);
if (relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`))) {
  throw new Error("Staging secrets input must be outside the Git worktree");
}
if (details.size <= 0 || details.size > 16 * 1024) throw new Error("Staging secrets input has an unsafe size");
if (process.platform !== "win32" && (details.mode & 0o077) !== 0) throw new Error("Staging secrets input must have 0600 permissions");

const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
  throw new Error("Staging secrets input must be a JSON object");
}
const names = Object.keys(parsed).sort();
if (JSON.stringify(names) !== JSON.stringify(requiredNames)) throw new Error("Staging secrets input must contain exactly the required OAuth secret names");
for (const name of requiredNames) {
  const value = parsed[name];
  if (typeof value !== "string" || value.trim().length < 16 || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Staging secret ${name} has an invalid value`);
  }
}

process.stdout.write(`${resolvedPath}\n`);
