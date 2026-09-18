import assert from 'node:assert/strict';
import test from 'node:test';
import { png, pdf, docxParts, zip } from './helpers/oa-attachment-fixtures.mjs';
import { readChatAttachments, unpackChatAttachmentZip, validateDocx, validateBinaryAttachment, ATTACHMENT_LIMITS } from '../lib/oa-chat-attachments.mjs';
test('single text imports preserve source exactly without calling a model or archive API', async () => {
  const text = '# 材料\n**保留原文**\n<img src=x onerror=alert(1)>\n';
  const bundle = await readChatAttachments([new File([text], '材料.md')], { extract() { throw new Error('unexpected model'); } });
  assert.equal(bundle.text, text); assert.equal(bundle.pkg.images.length, 0); assert.ok(bundle.id);
});
test('folders can combine documents and images, with explicit canonical original-image references', async () => {
  const files = [new File(['实验记录内容。'], '记录.txt'), new File([png], '平台.png'), new File([pdf], '说明.pdf'), zip(docxParts, { name: '报告.docx' })];
  files.forEach(file => Object.defineProperty(file, 'webkitRelativePath', { value: `项目/${file.name}` }));
  const calls = [];
  const bundle = await readChatAttachments(files, { folder: true, extract: async file => { calls.push(file.name); return `已解析 ${file.name}，缺失的数据需要核对。`; } });
  assert.deepEqual(calls, ['平台.png', '说明.pdf', '报告.docx']); assert.equal(bundle.parts.length, 4);
  assert.equal(bundle.pkg.images[0].path, 'assets/image-002.png'); assert.match(bundle.pkg.body, /!\[原图\]\(assets\/image-002.png\)/u);
  assert.equal(bundle.pkg.images[0].file, files[1]); assert.equal(bundle.parts[3].path, '项目/报告.docx');
});
for (const method of [0,8]) test(`generic ZIP accepts ordinary names and documents with method ${method}`, async () => {
  const source = zip([['资料/记录.md', '# 实验记录\n保留事实，不编造日期。'], ['资料/图片.png', png], ['论文.pdf', pdf]], { method });
  const files = await unpackChatAttachmentZip(source); assert.equal(files.length, 3); assert.equal(files[0].name, '资料/记录.md');
  const bundle = await readChatAttachments([source], { extract: async () => '完整的图片或文档解析正文。' }); assert.equal(bundle.parts.length, 3);
});
test('ZIP traversal, encryption, symlinks, duplicates, recursive archives and executables fail closed', async () => {
  for (const file of [zip([['../a.txt','content']]), zip([['a.txt','content']], {flags:1}), zip([['a.txt','content']], {mode:0xa000}), zip([['a.txt','one'],['A.TXT','two']]), zip([['nested.zip','contents']]), zip([['script.js','alert(1)']])]) await assert.rejects(unpackChatAttachmentZip(file));
});
test('CRC errors and declared-length ZIP bombs cannot become imported materials', async () => {
  await assert.rejects(unpackChatAttachmentZip(zip([['a.txt','content']], {checksumDelta:1})), /校验失败/);
  await assert.rejects(unpackChatAttachmentZip(zip([['a.txt','x'.repeat(100000)]], {method:8,declaredSize:1})), /声明值/);
});
test('DOCX structure is checked; macros, external entities and embedded resources are rejected', async () => {
  await validateDocx(zip(docxParts, {name:'good.docx'}));
  await assert.rejects(validateDocx(zip([['x.txt','not docx']], {name:'fake.docx'})), /不是有效/);
  await assert.rejects(validateDocx(zip([...docxParts, ['word/vbaProject.bin','macro']], {name:'macro.docx'})));
  await assert.rejects(validateDocx(zip([...docxParts, ['word/embeddings/book.xlsx','nested']], {name:'nested.docx'})));
  await assert.rejects(validateDocx(zip([...docxParts, ['word/_rels/document.xml.rels','<!DOCTYPE x [<!ENTITY leak SYSTEM "https://evil.invalid/">]><Relationships/>']], {name:'entity.docx'})), /实体/);
  await assert.rejects(validateDocx(zip([...docxParts, ['word/_rels/document.xml.rels','<Relationships><r:Relationship TargetMode="External" Type="urn:x/image" Target="https://evil.invalid/x"/></Relationships>']], {name:'remote.docx'})), /外部/);
});
test('metadata limits reject before reading or sending anything, and failures do not yield partial success', async () => {
  await assert.rejects(readChatAttachments([{name:'a.pdf',size:ATTACHMENT_LIMITS.document+1,arrayBuffer(){throw new Error('must not read');}}]), /过大/);
  await assert.rejects(readChatAttachments(Array.from({length:101},(_,i)=>new File(['内容'],`${i}.txt`))), /1–100/);
  await assert.rejects(readChatAttachments([new File(['已读文字'], 'a.txt'),new File(['bad pdf'], 'b.pdf')], { extract() { throw new Error('must not call'); } }));
  await assert.rejects(readChatAttachments([new File([Buffer.from([0xff])], 'bad.txt')]), /UTF-8/);
});
test('whole long text can be archived without silent truncation; processing limits are separate', async () => {
  const text = 'a'.repeat(50000) + '完整结尾';
  const bundle = await readChatAttachments([new File([text], '长资料.txt')]); assert.equal(bundle.text, text); assert.ok(bundle.pkg.body.endsWith('完整结尾'));
});
test('a fake extension or oversized PNG canvas cannot reach conversion', async () => {
  await assert.rejects(validateBinaryAttachment(new File(['<script>not PNG</script>'], 'image.png')));
  const huge = Buffer.from(png); huge.writeUInt32BE(100000,16); huge.writeUInt32BE(100000,20);
  await assert.rejects(validateBinaryAttachment(new File([huge], 'huge.png')), /像素/);
});
test('images missing from the selection are explicitly reported and not silently treated as uploaded', async () => {
  const bundle = await readChatAttachments([new File(['# 说明\n![缺图](assets/missing.png)\n保留后面的正文。'], 'index.md')]);
  assert.equal(bundle.warnings.length,1); assert.match(bundle.pkg.body,/未附带图片/u); assert.equal(bundle.pkg.images.length,0);
});

test('archival keeps image examples in code/comments unchanged and resolves inert HTML image references', async () => {
  const text = '# 图文\n`![示例](missing.png)`\n```md\n🦾 ![示例](missing.png)\n```\n<!-- ![示例](missing.png) -->\n<img src="图.png" alt="平台" onerror="alert(1)">';
  const bundle = await readChatAttachments([new File([text], '记录.md'),new File([png], '图.png')], {extract: async () => '图片解析仅用于此次合成测试。'});
  assert.equal(bundle.warnings.length, 0); assert.ok(bundle.pkg.body.includes('```md\n🦾 ![示例](missing.png)\n```'));
  assert.match(bundle.pkg.body, /!\[平台\]\(assets\/image-002.png\)/u); assert.doesNotMatch(bundle.pkg.body, /onerror/u);
});
