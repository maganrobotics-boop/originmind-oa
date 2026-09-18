import { readBoundedDocumentZip, safeDocumentPath } from './bounded-document-zip.mjs';
import { validateDocumentUpload } from '../chat-cloudflare/src/document-extraction.mjs';

export const ATTACHMENT_LIMITS = Object.freeze({ files: 100, zip: 50 * 1024 * 1024, total: 100 * 1024 * 1024, document: 10 * 1024 * 1024, image: 8 * 1024 * 1024, text: 5 * 1024 * 1024 });
export const CHAT_ATTACHMENT_ACCEPT = '.txt,.md,.markdown,.pdf,.docx,.png,.jpg,.jpeg,.webp,.zip';
const MIMES = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = message => { throw new Error(message); };
export function attachmentMime(name) { return MIMES[String(name).split('.').at(-1).toLowerCase()] || ''; }
function fileLimit(name) {
  const mime = attachmentMime(name);
  return mime.startsWith('image/') ? ATTACHMENT_LIMITS.image : mime.startsWith('text/') ? ATTACHMENT_LIMITS.text : mime ? ATTACHMENT_LIMITS.document : 0;
}
export function unpackChatAttachmentZip(file) { return readBoundedDocumentZip(file, { limitForPath: fileLimit }); }
export async function validateDocx(file) {
  const files = await readBoundedDocumentZip(file, { compressed: ATTACHMENT_LIMITS.document, total: 40 * 1024 * 1024, files: 1000, entries: 1200,
    limitForPath: path => /(?:^|\/)vbaProject\.bin$/iu.test(path) || /^word\/embeddings\//iu.test(path) || /\.(?:zip|exe|dll|js|vbs|cmd|bat|ps1)$/iu.test(path) ? 0 : 10 * 1024 * 1024 });
  const index = new Map(files.map(part => [part.name, part]));
  if (!index.has('[Content_Types].xml') || !index.has('word/document.xml')) fail('文件不是有效的 DOCX 文档。');
  const types = utf8.decode(await index.get('[Content_Types].xml').arrayBuffer());
  if (!types.includes('wordprocessingml.document.main+xml') || /macroEnabled|vbaProject/iu.test(types)) fail('只支持不含宏的 DOCX 文档。');
  for (const part of files) {
    if (!/\.(?:xml|rels)$/iu.test(part.name)) continue;
    const xml = utf8.decode(await part.arrayBuffer());
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) fail('DOCX 含有外部实体声明，请导出为 PDF 后上传。');
    // Hyperlinks are inert text. External embedded images/templates are not fetched.
    if ([...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/gu)].some(match => /TargetMode\s*=\s*["']External["']/iu.test(match[0]) && !/Type\s*=\s*["'][^"']*\/hyperlink["']/iu.test(match[0]))) fail('DOCX 包含外部图片或模板，请先嵌入文档后再上传。');
  }
}
export async function validateBinaryAttachment(file) {
  const mime = attachmentMime(file.name), name = file.name.split('/').at(-1);
  if (!mime || mime.startsWith('text/') || file.size <= 0 || file.size > fileLimit(name)) fail('文件类型或大小不符合要求。');
  if (mime === MIMES.docx) { await validateDocx(file); return { name, mimeType: mime, kind: 'Word' }; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const upload = validateDocumentUpload(name, mime, bytes);
  if (mime === 'image/png') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = view.getUint32(16), height = view.getUint32(20);
    if (width * height > 40000000) fail('图片像素过大，请缩小到 4000 万像素以内再上传。');
  }
  return upload;
}
export async function extractChatAttachment(file, { signal } = {}) {
  const mime = attachmentMime(file.name);
  const response = await fetch('/api/lab-ai/extract', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': mime, 'x-oa-file-name': encodeURIComponent(file.name.split('/').at(-1)) }, body: file,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.text !== 'string') fail(data.error || '文件解析未完成，原文件未归档，可重试。');
  return data.text;
}
function rewriteSourceImages(text, resolveImage) {
  // Mask, rather than delete, examples so all replacement offsets remain exact.
  let fence = null;
  const mask = text.split(/(?<=\n)/u).map(line => {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !line.slice(mark[0].length).trim()) fence = null;
      return line.replace(/[^\r\n]/g, ' ');
    }
    if (mark) { fence = mark[1]; return line.replace(/[^\r\n]/g, ' '); }
    return line;
  }).join('').replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, match => ' '.repeat(match.length))
    .replace(/(`+)([^`]|(?!\1)`)*?\1(?!`)/gu, match => ' '.repeat(match.length));
  const candidates = [];
  for (const match of mask.matchAll(/!\[([^\]\r\n]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu)) candidates.push({ start: match.index, end: match.index + match[0].length, alt: match[1], path: match[2] || match[3] });
  for (const match of mask.matchAll(/<img\b(?:[^<>"']|"[^"]*"|'[^']*')*>/giu)) {
    if (match[0].length > 16384) continue;
    const attrs = new Map(); let duplicate = false;
    for (const attr of match[0].slice(4, -1).matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
      const key = attr[1].toLowerCase(); if (!['src','alt'].includes(key)) continue;
      if (attrs.has(key)) duplicate = true; attrs.set(key, attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    if (!duplicate && attrs.has('src')) candidates.push({ start: match.index, end: match.index + match[0].length, alt: attrs.get('alt') || '', path: attrs.get('src') });
  }
  let output = '', cursor = 0;
  for (const part of candidates.sort((a,b) => a.start - b.start)) {
    if (part.start < cursor) continue;
    output += text.slice(cursor, part.start) + resolveImage(part.path, part.alt.replace(/[\[\]\r\n]/gu, ' ')); cursor = part.end;
  }
  return output + text.slice(cursor);
}
/** Keep prose local until an explicit task/archival request. Never render imported HTML. */
export async function readChatAttachments(selected, { folder = false, extract = extractChatAttachment, signal, onProgress = () => {} } = {}) {
  let files = Array.from(selected);
  if (files.length === 1 && /\.zip$/iu.test(files[0].name) && !folder) files = await unpackChatAttachmentZip(files[0]);
  if (!files.length || files.length > ATTACHMENT_LIMITS.files) fail('每次请选择 1–100 个文件。');
  const paths = files.map(file => safeDocumentPath(folder ? file.webkitRelativePath || file.name : file.name));
  const names = new Set(); let bytes = 0;
  for (let i = 0; i < files.length; i++) {
    if (names.has(paths[i].toLowerCase())) fail(`文件路径重复：${paths[i]}`);
    names.add(paths[i].toLowerCase());
    const limit = fileLimit(paths[i]);
    if (!limit) fail(`${paths[i]}：支持 TXT、MD、PDF、DOCX、PNG、JPG、WebP；ZIP 内不能再包含 ZIP。`);
    if (!Number.isFinite(files[i].size) || !files[i].size || files[i].size > limit) fail(`${paths[i]}：文件为空或过大（文档 10 MB，图片 8 MB，文字 5 MB）。`);
    bytes += files[i].size;
    if (bytes > ATTACHMENT_LIMITS.total) fail('本次资料总大小不能超过 100 MB。');
  }
  const parts = [], images = [];
  for (let i = 0; i < files.length; i++) {
    signal?.throwIfAborted(); onProgress(`正在解析 ${i + 1}/${files.length}：${paths[i]}`);
    const file = files[i], mime = attachmentMime(paths[i]);
    let text;
    if (mime.startsWith('text/')) {
      try { text = utf8.decode(await file.arrayBuffer()).replace(/^\uFEFF/u, ''); } catch { fail(`${paths[i]}：文字文件须使用 UTF-8 编码。`); }
      if (text.trim().length < 2 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/u.test(text)) fail(`${paths[i]}：文字为空或包含二进制控制字符。`);
    } else {
      await validateBinaryAttachment(file);
      text = await extract(file, { signal });
      if (typeof text !== 'string' || text.trim().length < 10 || new TextEncoder().encode(text).length > ATTACHMENT_LIMITS.text) fail(`${paths[i]}：解析结果为空或过大。`);
    }
    if (mime.startsWith('image/')) images.push({ path: `assets/image-${String(i + 1).padStart(3, '0')}.${paths[i].split('.').at(-1).toLowerCase()}`, alt: paths[i], file, type: mime });
    parts.push({ path: paths[i], file, mime, text });
  }
  signal?.throwIfAborted();
  const name = files.length === 1 ? files[0].name : `${folder ? '文件夹' : '资料包'}（${files.length} 个文件）`;
  // Preserve the exact text for a single TXT/MD import; the existing chat behavior stays intact.
  const text = parts.length === 1 && parts[0].mime.startsWith('text/') ? parts[0].text : parts.map(part => `## ${part.path}\n\n${part.text}`).join('\n\n');
  if (new TextEncoder().encode(text).length > ATTACHMENT_LIMITS.text) fail('解析正文合计超过 5 MB，请拆分资料；系统不会截断内容。');
  const id = crypto.randomUUID(), title = name.replace(/\.[^.]+$/u, '').slice(0, 100) || '聊天资料';
  const imagePaths = new Map(images.map(image => [image.alt, image.path]));
  const warnings = [];
  const body = parts.map(part => {
    const prose = rewriteSourceImages(part.text, (path, alt) => {
      let raw = path;
      try { raw = decodeURIComponent(raw).replace(/^\.\//u, ''); } catch { /* unmatched path is reported below */ }
      const parent = part.path.includes('/') ? part.path.slice(0, part.path.lastIndexOf('/') + 1) : '';
      const asset = imagePaths.get(parent + raw) || imagePaths.get(raw);
      if (asset) return `![${alt || '图片'}](${asset})`;
      warnings.push(`未附带的图片引用：${raw.slice(0, 180)}`);
      return `［未附带图片：${alt || raw.slice(0, 180)}］`;
    });
    const image = imagePaths.get(part.path);
    return `## ${part.path}\n\n${image ? `![原图](${image})\n\n` : ''}${prose}`;
  }).join('\n\n');
  if (new TextEncoder().encode(body).length > ATTACHMENT_LIMITS.text) fail('含图片说明的归档正文超过 5 MB，请拆分后上传。');
  const pkg = { id, title: title.length < 2 ? `${title}资料` : title, body, category: 'research', updatedAt: new Date().toISOString().slice(0, 10), images, unusedPaths: [], totalBytes: bytes };
  return { id, name, text, parts, warnings: [...new Set(warnings)], pkg };
}
