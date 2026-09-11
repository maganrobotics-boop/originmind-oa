import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  process.stderr.write("Usage: node scripts/generate-migration-export-credentials.mjs <new-directory>\n");
  process.exitCode = 64;
}

const requestedDirectory = process.argv[2];
if (!requestedDirectory || process.argv.length !== 3) {
  usage();
} else {
  const directory = resolve(requestedDirectory);
  const worktree = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const resolvedParent = await realpath(dirname(directory));
  const resolvedDestination = resolve(resolvedParent, basename(directory));
  const relativePath = relative(worktree, resolvedDestination);
  if (relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`))) {
    throw new Error("Migration credentials must be created outside the Git worktree");
  }
  await mkdir(directory, { mode: 0o700 });
  if (await realpath(directory) !== resolvedDestination) throw new Error("Migration credential directory resolved unexpectedly");
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", keyPair.publicKey),
    crypto.subtle.exportKey("jwk", keyPair.privateKey),
  ]);
  publicKey.alg = "RSA-OAEP-256";
  publicKey.use = "enc";
  publicKey.key_ops = ["encrypt"];
  privateKey.alg = "RSA-OAEP-256";
  privateKey.use = "enc";
  privateKey.key_ops = ["decrypt"];
  const authKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const authKey = Buffer.from(authKeyBytes).toString("base64url");
  authKeyBytes.fill(0);
  const freezeId = crypto.randomUUID();

  const privatePath = resolve(directory, "private-key.jwk");
  const publicPath = resolve(directory, "public-key.jwk");
  const authKeyPath = resolve(directory, "auth-key.txt");
  const freezeIdPath = resolve(directory, "freeze-id.txt");
  await Promise.all([
    writeFile(privatePath, `${JSON.stringify(privateKey)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }),
    writeFile(publicPath, `${JSON.stringify(publicKey)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }),
    writeFile(authKeyPath, `${authKey}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }),
    writeFile(freezeIdPath, `${freezeId}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  ]);
  process.stdout.write(`Created one-time encrypted-migration credentials in ${directory}; use freeze-id.txt only for this freeze attempt and keep private-key.jwk and auth-key.txt secret.\n`);
}
