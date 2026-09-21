const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const MAX_OA_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;

export function validOaChatImage(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)
    || typeof image.url !== 'string' || typeof image.alt !== 'string'
    || image.alt.length > 300 || !IMAGE_MIME_TYPES.has(image.mimeType)) return false;
  if (!image.url.startsWith('/') || image.url.startsWith('//') || !image.url.isWellFormed()) return false;
  let url;
  try { url = new URL(image.url, 'https://oa.invalid'); } catch { return false; }
  if (url.origin !== 'https://oa.invalid' || url.hash || url.username || url.password) return false;
  if (url.searchParams.size !== 2 || url.searchParams.getAll('forChat').length !== 1
    || url.searchParams.get('forChat') !== '1' || url.searchParams.getAll('revision').length !== 1
    || !UUID_PATTERN.test(url.searchParams.get('revision') || '')) return false;
  const match = /^\/api\/knowledge\/([^/]+)\/assets\/(.+)$/u.exec(url.pathname);
  if (!match) return false;
  let itemId;
  let assetPath;
  try {
    itemId = decodeURIComponent(match[1]);
    assetPath = match[2].split('/').map(decodeURIComponent).join('/');
  } catch { return false; }
  return UUID_PATTERN.test(itemId)
    && assetPath.startsWith('assets/')
    && assetPath.length <= 500
    && !assetPath.includes('\\')
    && !assetPath.split('/').some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/u.test(part));
}
