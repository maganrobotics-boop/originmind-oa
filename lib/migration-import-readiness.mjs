export async function waitForMigrationImporter(url, expectedProof, child, maximumMs = 30_000, fetchImplementation = fetch) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(expectedProof)) throw new Error("Local importer readiness proof is invalid");
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Local migration importer stopped before it was ready");
    try {
      const response = await fetchImplementation(url, { method: "GET", signal: AbortSignal.timeout(1_000) });
      const declaredLength = Number(response.headers.get("content-length") || "0");
      if (response.status === 200 && Number.isFinite(declaredLength) && declaredLength <= 1_024) {
        const serialized = await response.text();
        if (serialized.length <= 1_024 && JSON.parse(serialized)?.ready === expectedProof) return;
      }
    } catch { /* The authenticated local listener is still starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Local migration importer did not prove its identity before the deadline");
}
