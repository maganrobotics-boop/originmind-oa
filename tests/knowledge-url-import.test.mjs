import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchKnowledgeUrl, parseKnowledgeUrlCommand, readableWebDocument, safeKnowledgeSourceUrl } from '../lib/knowledge-url-import.mjs';

test('chat link command is explicit and bounded to HTTP URLs', () => {
  assert.equal(parseKnowledgeUrlCommand('@上传资料 https://example.com/a'), 'https://example.com/a');
  assert.equal(parseKnowledgeUrlCommand('请上传 https://example.com'), null);
  assert.equal(safeKnowledgeSourceUrl('http://127.0.0.1/private'), null);
  assert.equal(safeKnowledgeSourceUrl('http://192.168.1.2/private'), null);
  assert.equal(safeKnowledgeSourceUrl('https://user:pass@example.com'), null);
  assert.equal(safeKnowledgeSourceUrl('https://example.com/a')?.hostname, 'example.com');
});

test('web import extracts title and readable text without scripts', () => {
  const result = readableWebDocument('<title>测试 页面</title><script>secret()</script><h1>标题</h1><p>这是正文内容，足够提交审核。</p>', 'text/html', new URL('https://example.com'));
  assert.equal(result.title, '测试 页面'); assert.match(result.content, /这是正文内容/u); assert.doesNotMatch(result.content, /secret/u);
});

test('fetch import validates redirects and response types', async () => {
  const calls = [];
  const result = await fetchKnowledgeUrl('https://example.com/start', async url => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: '/final' } });
    return new Response('这是可以进入审核流程的纯文本链接内容。', { headers: { 'content-type': 'text/plain' } });
  });
  assert.deepEqual(calls, ['https://example.com/start', 'https://example.com/final']);
  assert.equal(result.sourceUrl, 'https://example.com/final');
});
