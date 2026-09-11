import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const releaseScript = await readFile(new URL("../scripts/release-standalone.sh", import.meta.url), "utf8");
const secretListValidator = await readFile(new URL("../scripts/validate-staging-secret-list.mjs", import.meta.url), "utf8");

test("the staging release requires an explicit isolated target before running commands", () => {
  const result = spawnSync("/bin/bash", [new URL("../scripts/release-standalone.sh", import.meta.url).pathname, "staging"], {
    encoding: "utf8",
    env: { PATH: "/nonexistent", OA_STAGING_RELEASE_CONFIRM: "originmind-oa-staging" },
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /OA_STAGING_WORKER_NAME/u);
  assert.doesNotMatch(result.stderr, /command not found/u);
});

test("staging release uses one guarded immutable standalone artifact", () => {
  assert.equal(packageJson.scripts["release:standalone:staging"], "bash scripts/release-standalone.sh staging");
  assert.match(releaseScript, /OA_STAGING_WORKER_NAME/u);
  assert.match(releaseScript, /OA_STAGING_D1_DATABASE_NAME/u);
  assert.match(releaseScript, /OA_STAGING_RELEASE_CONFIRM/u);
  assert.match(releaseScript, /flock -n/u);
  assert.match(releaseScript, /validate-staging-secrets-file\.mjs/u);
  assert.match(releaseScript, /validate-staging-secret-list\.mjs/u);
  assert.match(releaseScript, /if \[\[ -n "\$\{OA_STAGING_SECRETS_FILE:-\}" \]\]/u);
  assert.match(releaseScript, /--secrets-file/u);

  const ordinaryTest = releaseScript.indexOf("npm test");
  const standaloneBuild = releaseScript.indexOf("npm run build:standalone:staging");
  const snapshotMove = releaseScript.indexOf('mv "${project_root}\/dist"');
  const dryRun = releaseScript.indexOf("deploy --dry-run --strict");
  const migrations = releaseScript.indexOf("d1 migrations apply DB");
  const finalDeploy = releaseScript.indexOf("deploy --strict --config", dryRun + 1);

  assert.ok(ordinaryTest >= 0 && ordinaryTest < standaloneBuild);
  assert.ok(standaloneBuild < snapshotMove && snapshotMove < dryRun);
  assert.ok(dryRun < migrations && migrations < finalDeploy);
  assert.doesNotMatch(releaseScript, /\bwrangler deploy(?![^\n]*--config)/u);
  assert.doesNotMatch(releaseScript, /[0-9a-f]{32}/iu);
  assert.match(secretListValidator, /GITHUB_OAUTH_CLIENT_SECRET/u);
  assert.match(secretListValidator, /FEISHU_LOGIN_APP_SECRET/u);
});
