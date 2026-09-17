import { knowledgeImageReferences } from './knowledge-image-references.mjs';

export const PACKAGE_LIMITS = Object.freeze({ files: 100, zip: 50 * 1024 * 1024, total: 100 * 1024 * 1024, markdown: 5 * 1024 * 1024, image: 8 * 1024 * 1024 });
const ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:png|webp|jpe?g)$/iu;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = message => { throw new Error(message); };

export function normalizePackagePath(input) {
  const path = String(input).normalize('NFC').replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!path || path.startsWith('/') || /^[a-z]:/iu.test(path) || /[\u0000-\u001f\u007f]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('资料中存在不安全的文件路径。');
  return path;
}

function imageType(bytes) {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  fail('图片内容不是有效的 JPG、PNG 或 WebP 文件。');
}

/** File selection stays local until the separate submit action. */
export async function prepareKnowledgePackage(selected, folder = false) {
  const files = Array.from(selected);
  if (!files.length || files.length > PACKAGE_LIMITS.files) fail('每包资料需要 1–100 个文件，请拆分后上传。');
  const paths = files.map(file => normalizePackagePath(folder ? (file.webkitRelativePath || file.name) : file.name));
  const prefix = folder && paths.every(path => path.includes('/') && path.split('/')[0] === paths[0].split('/')[0]) ? paths[0].split('/')[0] + '/' : '';
  const byPath = new Map(); const folded = new Set(); let total = 0;
  for (let i = 0; i < files.length; i++) {
    const path = normalizePackagePath(prefix ? paths[i].slice(prefix.length) : paths[i]);
    if (folded.has(path.toLowerCase())) fail(`重复文件路径：${path}`);
    folded.add(path.toLowerCase());
    if (path !== 'index.md' && !ASSET.test(path)) fail(`${path}：只允许根目录 index.md 和 assets/ 下的 JPG、PNG、WebP。`);
    const limit = path === 'index.md' ? PACKAGE_LIMITS.markdown : PACKAGE_LIMITS.image;
    if (files[i].size > limit) fail(`${path} 超过大小限制（正文 5 MB，单图 8 MB）。`);
    total += files[i].size;
    if (total > PACKAGE_LIMITS.total) fail('解压后的资料不能超过 100 MB。');
    byPath.set(path, files[i]);
  }
  const index = byPath.get('index.md');
  if (!index) fail('资料必须包含一个根目录 index.md。');
  let body;
  try { body = utf8.decode(await index.arrayBuffer()).replace(/^\uFEFF/u, ''); }
  catch { fail('index.md 必须使用 UTF-8 编码。'); }
  if (body.trim().length < 10) fail('正文至少需要 10 个字符。');
  const references = knowledgeImageReferences(body);
  const images = [];
  for (const [path, alt] of references) {
    const file = byPath.get(path);
    if (!file) fail(`正文引用了缺失图片或大小写不一致的路径：${path}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = imageType(bytes);
    const extensionType = /\.png$/iu.test(path) ? 'image/png' : /\.webp$/iu.test(path) ? 'image/webp' : 'image/jpeg';
    if (type !== extensionType) fail(`${path} 的扩展名与图片内容不一致。`);
    images.push({ path, alt, file, type });
  }
  const unusedPaths = [...byPath.keys()].filter(path => path !== 'index.md' && !references.has(path));
  const title = Array.from(body.match(/^#\s+(.+)$/mu)?.[1]?.trim() || '实验室图文资料').slice(0, 100).join('');
  // Keep one document identity across retries; the server supplies the authoritative owner and revision.
  return { id: crypto.randomUUID(), title, body, category: 'research', updatedAt: new Date().toISOString().slice(0, 10), images, unusedPaths, totalBytes: total };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateBounded(bytes, expected) {
  if (typeof DecompressionStream !== 'function') fail('当前浏览器不支持 ZIP 解压，请使用文件夹入口或新版浏览器。');
  let reader;
  try { reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(); }
  catch { fail('当前浏览器不支持此 ZIP 压缩方式，请使用文件夹入口。'); }
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > expected) { await reader.cancel(); fail('ZIP 实际解压大小超过声明值。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (length !== expected) fail('ZIP 解压大小不匹配。');
  const output = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

/** Strict ZIP reader: bounded inflation, CRC, duplicate/path/link checks, no ZIP64 or encryption. */
export async function unpackKnowledgeZip(file) {
  if (file.size > PACKAGE_LIMITS.zip) fail('ZIP 不能超过 50 MB。');
  const buffer = await file.arrayBuffer(); const view = new DataView(buffer);
  let end = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) { end = i; break; }
  }
  if (end < 0) fail('ZIP 文件已损坏。');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535 || start === 0xffffffff || size === 0xffffffff) fail('不支持分卷或 ZIP64 文件。');
  if (!count || count > 300 || start + size !== end) fail('ZIP 中央目录或文件数量不正确。');
  const entries = []; const names = new Set(); let cursor = start; let total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail('ZIP 目录条目损坏。');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), checksum = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true), expanded = view.getUint32(cursor + 24, true), n = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true), offset = view.getUint32(cursor + 42, true);
    const mode = view.getUint32(cursor + 38, true) >>> 16;
    if (cursor + 46 + n + extra + comment > end || compressed === 0xffffffff || expanded === 0xffffffff || view.getUint16(cursor + 34, true)) fail('ZIP 条目边界不正确。');
    if ((flags & 0x2041) || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000) fail('ZIP 不能包含加密内容、符号链接或不支持的压缩。');
    const rawName = utf8.decode(new Uint8Array(buffer, cursor + 46, n));
    const directory = rawName.endsWith('/'); const name = normalizePackagePath(directory ? rawName.slice(0, -1) : rawName);
    if (names.has(name.toLowerCase())) fail(`ZIP 路径重复：${name}`);
    names.add(name.toLowerCase()); cursor += 46 + n + extra + comment;
    if (directory) { if (expanded !== 0) fail('ZIP 目录含有数据。'); continue; }
    if (name !== 'index.md' && !ASSET.test(name)) fail(`ZIP 不支持文件：${name}`);
    if (expanded > (name === 'index.md' ? PACKAGE_LIMITS.markdown : PACKAGE_LIMITS.image)) fail(`${name} 超过大小限制。`);
    total += expanded;
    if (total > PACKAGE_LIMITS.total || entries.length >= PACKAGE_LIMITS.files) fail('ZIP 解压后过大或文件超过 100 个。');
    if (offset + 30 > start || view.getUint32(offset, true) !== 0x04034b50 || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method) fail('ZIP 本地文件头不匹配。');
    const localNameLength = view.getUint16(offset + 26, true), localExtraLength = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressed > start || utf8.decode(new Uint8Array(buffer, offset + 30, localNameLength)) !== rawName) fail('ZIP 本地路径或数据范围不匹配。');
    entries.push({ name, method, compressed, expanded, checksum, dataStart, offset });
  }
  if (cursor !== end) fail('ZIP 目录长度不匹配。');
  const ordered = [...entries].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++) if (ordered[i].offset < ordered[i - 1].dataStart + ordered[i - 1].compressed) fail('ZIP 数据范围重叠。');
  const output = [];
  for (const entry of entries) {
    const packed = new Uint8Array(buffer, entry.dataStart, entry.compressed);
    const bytes = entry.method === 0 ? packed.slice() : await inflateBounded(packed, entry.expanded);
    if (bytes.length !== entry.expanded || crc32(bytes) !== entry.checksum) fail(`${entry.name} 内容校验失败。`);
    output.push(new File([bytes], entry.name, { lastModified: file.lastModified }));
  }
  return output;
}

// An acknowledged asset session belongs to this in-memory package, not to localStorage.
// Import retries issue fresh tokens; existing immutable assets must keep their first token.
const packageUploadSessions = new WeakMap();

/** Same-origin OA writes reuse the existing audited import/assets protocol; nothing is auto-approved. */
export async function submitKnowledgePackage(pkg, { fetcher = fetch, onProgress = () => {}, returnedKnowledgeItemId } = {}) {
  async function request(url, options) {
    const response = await fetcher(url, { ...options, credentials: 'same-origin', signal: AbortSignal.timeout(90000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.received !== true) fail(data.error || `上传未完成（${response.status}），可保留当前资料重试。`);
    return data;
  }
  const payload = { document: { id: pkg.id, title: pkg.title, body: pkg.body, category: pkg.category, updatedAt: pkg.updatedAt, url: '' }, ...(returnedKnowledgeItemId ? { returnedKnowledgeItemId } : {}) };
  const payloadText = JSON.stringify(payload);
  const previous = packageUploadSessions.get(pkg);
  if (previous && (previous.payloadText !== payloadText || previous.images.length !== pkg.images.length || previous.images.some((image, index) => image.path !== pkg.images[index].path || image.type !== pkg.images[index].type || image.file !== pkg.images[index].file))) {
    fail('已开始上传的资料不能在重试时改动，请重新选择资料后提交。');
  }
  onProgress('正在提交正文…');
  const result = await request('/api/knowledge/import-chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payloadText });
  if (!result.item?.id) fail('正文可能已接收，但未获得资料编号；请重试。');
  if (pkg.images.length) {
    if (!result.assetUpload?.revisionId || !result.assetUpload?.uploadToken) fail('正文可能已接收，但未获得完整图片上传会话；请重试。');
    const { revisionId } = result.assetUpload;
    if (previous && (previous.itemId !== result.item.id || previous.revisionId !== revisionId)) {
      fail('资料所属条目或版本已变化，已停止图片写入，请重新加载后核对。');
    }
    const uploadToken = previous?.uploadToken || result.assetUpload.uploadToken;
    packageUploadSessions.set(pkg, { payloadText, itemId: result.item.id, revisionId, uploadToken, images: pkg.images.map(image => ({ path: image.path, type: image.type, file: image.file })) });
    for (let i = 0; i < pkg.images.length; i++) {
      const image = pkg.images[i]; onProgress(`正在上传图片 ${i + 1} / ${pkg.images.length}…`);
      await request('/api/knowledge/assets', { method: 'PUT', headers: { 'content-type': image.type, 'x-knowledge-item-id': result.item.id, 'x-knowledge-revision-id': revisionId, 'x-knowledge-upload-token': uploadToken, 'x-knowledge-asset-path': image.path }, body: image.file });
    }
    onProgress('正在核对图文完整性…');
    await request('/api/knowledge/assets/finalize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId: result.item.id, revisionId, uploadToken, expectedPaths: pkg.images.map(image => image.path) }) });
    result.assetUpload = { ...result.assetUpload, uploadToken };
  }
  // Text-only packages have no asset manifest; the server intentionally rejects empty manifests.
  onProgress('已完整提交 OA 待审核');
  return result;
}
