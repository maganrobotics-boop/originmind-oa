const MAX_BYTES = 1_000_000;

export function parseKnowledgeUrlCommand(value) {
  const match = String(value || '').trim().match(/^[@＠]上传资料\s+(https?:\/\/\S+)$/iu);
  return match ? match[1] : null;
}

export function safeKnowledgeSourceUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if (url.port && !['80', '443'].includes(url.port)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
    if (/^(?:0|10|127|169\.254|192\.168)(?:\.|$)/u.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)) return null;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return null;
    return url;
  } catch { return null; }
}

function decodeHtml(value) {
  return value.replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/&quot;/giu, '"').replace(/&#39;/giu, "'").replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)));
}

export function readableWebDocument(raw, contentType, url) {
  const isHtml = /(?:text\/html|application\/xhtml\+xml)/iu.test(contentType);
  let title = '';
  let content = String(raw || '');
  if (isHtml) {
    title = decodeHtml(content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] || '').replace(/\s+/gu, ' ').trim();
    content = content.replace(/<(?:script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|template)>/giu, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/giu, '\n')
      .replace(/<[^>]+>/gu, ' ');
  }
  content = decodeHtml(content).replace(/\r\n?/gu, '\n').replace(/[ \t]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
  if (content.length < 10) throw new Error('LINK_CONTENT_EMPTY');
  if (content.length > 20_000) content = content.slice(0, 20_000);
  return { title: (title || url.hostname).slice(0, 100), content };
}

export async function fetchKnowledgeUrl(value, fetcher = fetch) {
  let url = safeKnowledgeSourceUrl(value);
  if (!url) throw new Error('LINK_URL_UNSAFE');
  for (let redirect = 0; redirect < 3; redirect += 1) {
    const response = await fetcher(url, { method: 'GET', redirect: 'manual', headers: { accept: 'text/html,text/plain,application/xhtml+xml;q=0.9' }, signal: AbortSignal.timeout(15_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      url = location ? safeKnowledgeSourceUrl(new URL(location, url).toString()) : null;
      if (!url) throw new Error('LINK_URL_UNSAFE');
      continue;
    }
    if (!response.ok) throw new Error('LINK_FETCH_FAILED');
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
    if (!['text/html', 'text/plain', 'application/xhtml+xml'].includes(type)) throw new Error('LINK_TYPE_UNSUPPORTED');
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error('LINK_TOO_LARGE');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error('LINK_TOO_LARGE');
    const document = readableWebDocument(new TextDecoder('utf-8', { fatal: false }).decode(bytes), type, url);
    return { ...document, sourceUrl: url.toString() };
  }
  throw new Error('LINK_REDIRECT_LIMIT');
}
