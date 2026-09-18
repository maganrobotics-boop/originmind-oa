import { deflateRawSync } from 'node:zlib';
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=', 'base64');
export const pdf = Buffer.from('%PDF-1.4\nsynthetic test document\n%%EOF');
export const docxParts = [['[Content_Types].xml', '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'], ['word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>测试文档</w:t></w:r></w:p></w:body></w:document>']];
function crc(bytes) { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1)); } return (n ^ 0xffffffff) >>> 0; }
export function zip(entries, { method = 0, checksumDelta = 0, declaredSize, flags = 0, mode = 0, name = '资料.zip' } = {}) {
  const locals = [], central = []; let offset = 0;
  for (const [path, raw] of entries) {
    const bytes = Buffer.from(raw), encoded = Buffer.from(path), packed = method === 8 ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE((crc(bytes) + checksumDelta) >>> 0, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(declaredSize ?? bytes.length, 22); local.writeUInt16LE(encoded.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE((crc(bytes) + checksumDelta) >>> 0, 16); directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(declaredSize ?? bytes.length, 24); directory.writeUInt16LE(encoded.length, 28); directory.writeUInt32LE((mode << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    locals.push(local, encoded, packed); central.push(directory, encoded); offset += local.length + encoded.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new File([Buffer.concat([...locals, directory, end])], name);
}
