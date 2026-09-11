import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const validator = join(projectRoot, "scripts/validate-staging-secrets-file.mjs");
const listValidator = join(projectRoot, "scripts/validate-staging-secret-list.mjs");
const validSecrets = {
  FEISHU_LOGIN_APP_SECRET: "feishu-secret-value-for-test",
  GITHUB_OAUTH_CLIENT_SECRET: "github-secret-value-for-test",
};

function validateSecretList(input) {
  const result = spawnSync(process.execPath, [listValidator], { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `secret list validator exited ${result.status}`);
  return result.stdout;
}

test("staging OAuth secrets are accepted only from a private exact JSON file outside the worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "originmind-staging-secrets-test-"));
  try {
    const path = join(directory, "secrets.json");
    await writeFile(path, `${JSON.stringify(validSecrets)}\n`, { mode: 0o600 });
    const { stdout } = await execute(process.execPath, [validator, path]);
    assert.equal(stdout.trim(), path);

    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await assert.rejects(execute(process.execPath, [validator, path]), /0600 permissions/u);
      await chmod(path, 0o600);
    }
    await writeFile(path, `${JSON.stringify({ ...validSecrets, UNEXPECTED_SECRET: "not-allowed-in-this-release" })}\n`, { mode: 0o600 });
    await assert.rejects(execute(process.execPath, [validator, path]), /exactly the required/u);

    const readme = join(projectRoot, "README.md");
    assert.ok((await readFile(readme, "utf8")).length > 0);
    await assert.rejects(execute(process.execPath, [validator, readme]), /outside the Git worktree/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard-configured staging secrets expose only the exact required names", async () => {
  const exact = JSON.stringify([
    { name: "FEISHU_LOGIN_APP_SECRET", type: "secret_text" },
    { name: "GITHUB_OAUTH_CLIENT_SECRET", type: "secret_text" },
  ]);
  const stdout = validateSecretList(exact);
  assert.match(stdout, /secret names are configured/u);

  assert.throws(
    () => validateSecretList(JSON.stringify([])),
    /exactly these secrets/u,
  );
  assert.throws(() => validateSecretList(JSON.stringify([{ name: "GITHUB_OAUTH_CLIENT_SECRET" }])), /exactly these secrets/u);
  assert.throws(
    () => validateSecretList(JSON.stringify({ name: "GITHUB_OAUTH_CLIENT_SECRET" })),
    /must be an array/u,
  );
});
