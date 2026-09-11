/** Retire the previous OA entry without replaying forms or OAuth credentials. */
export function legacyOaRedirect(request, enabled) {
  const source = new URL(request.url);
  if (enabled !== "true" || source.hostname !== "oa.originmindos.com") return null;
  const target = new URL("https://oa.omindos.ai/");
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (readOnly && !source.pathname.startsWith("/api/")) target.pathname = source.pathname;
  // Old OAuth codes, state values and other query data must not cross hosts.
  return new Response(null, {
    status: readOnly ? 308 : 303,
    headers: { location: target.href, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
