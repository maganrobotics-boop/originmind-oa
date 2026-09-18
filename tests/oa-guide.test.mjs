import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('guide describes public Chat and authenticated OA without granting broader access', async () => {
  const source = await read('app/guide/page.tsx');
  for (const text of ['内部公开 ≠ 对外公开', '公众无需 OA 登录', '完成成员准入与保密签署', '原则上仅在 OA 内部共享', '不适合成员共享的内容不要提交到一般知识库', '不要把内部材料粘贴到对外 Chat']) assert.ok(source.includes(text), text);
  assert.doesNotMatch(source, /(?:fetch\s*\(|getDb\s*\(|dangerouslySetInnerHTML|from ["'][^"']*(?:knowledge-store|\/auth)["'])/u);
  assert.ok(source.includes('本指南在登录前也可阅读，但只介绍操作方法，不展示内部资料'));
});

test('guide uses current navigation and a complete in-chat document workflow', async () => {
  const source = await read('app/guide/page.tsx');
  for (const text of ['实验室大模型 → AI 助手', '上传资料', '我的资料', '资料审核', '知识资料管理', '新建审核申请', '待我审批', '实验室大模型能做什么', '上传文件夹', 'TXT、MD、PDF、DOCX、PNG、JPG、WebP', '打开文档', '下载 Word', '下载 Markdown', '继续修改', '已保存文档', '20,000 字']) assert.ok(source.includes(text), text);
  assert.doesNotMatch(source, /实验室 AI（内部）|大模型与资料|“AI 聊天”|“提交知识”|“我的提交”/u);
  for (const label of ['知识问答', '资料整理', '会议纪要', '项目总结']) assert.ok(source.includes(`["${label}",`));
});

test('guide separates temporary retention, review and public approval', async () => {
  const source = await read('app/guide/page.tsx');
  for (const text of ['归档资料', '归档成果', '确认归档并提交 OA', '待审核', '仅 OA 内部', '对外公开必须再次输入指定确认文字', 'OA 管理员可以批准本人提交的知识；项目负责人仍需回避自己的投稿', '不参与临时清理', '不是永久保留承诺', '历史成果不追溯自动清理', '不能收回别人已复制', '组会资料的完整示例', '以下是操作示例，不含实际组会内容']) assert.ok(source.includes(text), text);
});

test('guide preserves charter, approvals and personal-account boundaries', async () => {
  const source = await read('app/guide/page.tsx');
  for (const text of ['协作章程草案', '待审阅', '具体保密义务以本人签署的文件为准', '合计为 100%', '经费负责人终审', '已归档记录保留原版本', '不能代替本人签署', '不是 AI', '图片附件不随本条正文转发', '清空本页显示']) assert.ok(source.includes(text), text);
  assert.equal((source.match(/className="guide-clause"/gu) || []).length, 8);
  assert.equal((source.match(/<h1>/gu) || []).length, 1);
  const ids = [...source.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'static section ids are unique');
  for (const match of source.matchAll(/href="#([^"]+)"/gu)) assert.ok(ids.includes(match[1]), `missing anchor ${match[1]}`);
  for (const match of source.matchAll(/id: "([^"]+)"/gu)) assert.ok(ids.includes(match[1]), `missing scenario ${match[1]}`);
  assert.ok(source.includes('<details><summary>'));
});

test('guide retains narrow-screen wrapping and visible keyboard navigation', async () => {
  const css = await read('app/guide/guide.css');
  for (const text of ['overflow-wrap: anywhere', 'minmax(0, 1fr)', '@media (max-width: 600px)', '.guide-skip:focus', 'summary:focus-visible', 'min-height: 44px']) assert.ok(css.includes(text), text);
  assert.doesNotMatch(css, /(?:text-overflow:\s*ellipsis|white-space:\s*nowrap)/u);
});
