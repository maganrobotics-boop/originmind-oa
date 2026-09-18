/** Parse ZIPs as inert data. No filesystem writes, recursive archives or external fetches. */
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = message => { throw new Error(message); };
export function safeDocumentPath(input) {
  const path = String(input).normalize('NFC').replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!path || path.length > 512 || path.startsWith('/') || /^[a-z]:/iu.test(path)
    || /[\u0000-\u001f\u007f]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('文件路径不安全，请重新选择资料。');
  return path;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
async function inflate(bytes, expected) {
  if (typeof DecompressionStream !== 'function') fail('浏览器不支持 ZIP 解压，请改用文件夹入口。');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > expected) fail('ZIP 解压大小超过声明值，已停止处理。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (size !== expected) fail('ZIP 解压大小不匹配。');
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
/** The caller supplies an allowlist and hard byte/entry budgets; every byte is CRC checked. */
export async function readBoundedDocumentZip(file, { files = 100, entries = 300, total = 100 * 1024 * 1024, compressed = 50 * 1024 * 1024, limitForPath } = {}) {
  if (typeof limitForPath !== 'function') fail('缺少 ZIP 文件类型检查。');
  if (!file || !Number.isFinite(file.size) || file.size < 22 || file.size > compressed) fail('ZIP 为空、损坏或超过大小限制。');
  const buffer = await file.arrayBuffer(), view = new DataView(buffer);
  if (buffer.byteLength !== file.size || buffer.byteLength > compressed) fail('ZIP 大小不匹配。');
  let end = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) { end = i; break; }
  }
  if (end < 0) fail('ZIP 文件已损坏。');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count
    || count === 65535 || start === 0xffffffff || size === 0xffffffff) fail('不支持分卷或 ZIP64 文件。');
  if (!count || count > entries || start + size !== end) fail('ZIP 目录或文件数量不正确。');
  const selected = [], names = new Set(); let cursor = start, expandedTotal = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail('ZIP 目录损坏。');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), checksum = view.getUint32(cursor + 16, true);
    const packed = view.getUint32(cursor + 20, true), expanded = view.getUint32(cursor + 24, true), n = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true), offset = view.getUint32(cursor + 42, true);
    const mode = view.getUint32(cursor + 38, true) >>> 16;
    if (cursor + 46 + n + extra + comment > end || packed === 0xffffffff || expanded === 0xffffffff || view.getUint16(cursor + 34, true)) fail('ZIP 条目边界不正确。');
    if ((flags & 0x2041) || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000) fail('ZIP 不能包含加密内容、符号链接或不支持的压缩。');
    let rawName; try { rawName = utf8.decode(new Uint8Array(buffer, cursor + 46, n)); } catch { fail('ZIP 文件名须采用 UTF-8 编码，请重新压缩。'); }
    const directory = rawName.endsWith('/'), name = safeDocumentPath(directory ? rawName.slice(0, -1) : rawName);
    if (names.has(name.toLowerCase())) fail(`ZIP 存在重复路径：${name}`);
    names.add(name.toLowerCase()); cursor += 46 + n + extra + comment;
    if (directory && expanded !== 0) fail('ZIP 目录包含文件数据。');
    const maximum = directory ? 0 : limitForPath(name);
    if (!directory && (!Number.isSafeInteger(maximum) || maximum < 1 || expanded > maximum)) fail(`${name}：格式不支持或文件过大。`);
    expandedTotal += expanded;
    if (expandedTotal > total || selected.filter(entry => !entry.directory).length + (directory ? 0 : 1) > files) fail('ZIP 解压后过大或文件数量超过限制。');
    if (offset + 30 > start || view.getUint32(offset, true) !== 0x04034b50 || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method) fail('ZIP 本地文件头不匹配。');
    const localName = view.getUint16(offset + 26, true), localExtra = view.getUint16(offset + 28, true), dataStart = offset + 30 + localName + localExtra;
    if (dataStart + packed > start || utf8.decode(new Uint8Array(buffer, offset + 30, localName)) !== rawName) fail('ZIP 本地路径或数据范围不匹配。');
    selected.push({ name, directory, method, checksum, packed, expanded, offset, dataStart });
  }
  if (cursor !== end) fail('ZIP 目录长度不匹配。');
  const ordered = [...selected].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++) if (ordered[i].offset < ordered[i - 1].dataStart + ordered[i - 1].packed) fail('ZIP 数据范围重叠。');
  const output = [];
  for (const entry of selected) {
    const packed = new Uint8Array(buffer, entry.dataStart, entry.packed);
    const bytes = entry.method === 0 ? packed.slice() : await inflate(packed, entry.expanded);
    if (bytes.length !== entry.expanded || crc32(bytes) !== entry.checksum) fail(`${entry.name} 内容校验失败。`);
    if (!entry.directory) output.push(new File([bytes], entry.name, { lastModified: file.lastModified }));
  }
  return output;
}
