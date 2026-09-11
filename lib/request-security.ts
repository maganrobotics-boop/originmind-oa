const UNTRUSTED_EDGE_HEADER_PREFIXES = ["oai-"] as const;

/**
 * A standalone public Worker must never trust identity headers that are only
 * authenticated by the OpenAI Sites dispatcher. Remove them before the
 * application router sees the request so they cannot become a login or account
 * linking signal outside Sites.
 */
export function withoutUntrustedEdgeHeaders(request: Request): Request {
  const requestHeaders = new Headers(request.headers);
  for (const headerName of [...requestHeaders.keys()]) {
    const normalizedName = headerName.toLowerCase();
    if (UNTRUSTED_EDGE_HEADER_PREFIXES.some((prefix) => normalizedName.startsWith(prefix))) {
      requestHeaders.delete(headerName);
    }
  }
  return new Request(request, { headers: requestHeaders });
}
