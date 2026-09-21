import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_OA_CHAT_IMAGE_BYTES, validOaChatImage } from '../lib/oa-chat-image.mjs';

const itemId = '11111111-2222-4333-8444-555555555555';
const revisionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('OA 检索图片接受安全的同源资源地址和编码文件名', () => {
  assert.equal(MAX_OA_CHAT_IMAGE_BYTES, 8 * 1024 * 1024);
  assert.equal(validOaChatImage({
    url: `/api/knowledge/${itemId}/assets/assets/%E8%BD%AE%E8%B6%B3%20%E6%9C%BA%E5%99%A8%E4%BA%BA.webp?forChat=1&revision=${revisionId}`,
    alt: '轮足机器人',
    mimeType: 'image/webp',
  }), true);
});

test('OA 检索图片拒绝跨站、路径穿越、重复查询参数和非图片类型', () => {
  const base = `/api/knowledge/${itemId}/assets/assets/robot.webp?forChat=1&revision=${revisionId}`;
  for (const image of [
    { url: `https://evil.example${base}`, alt: 'x', mimeType: 'image/webp' },
    { url: `/api/knowledge/${itemId}/assets/assets/%2E%2E/secret.webp?forChat=1&revision=${revisionId}`, alt: 'x', mimeType: 'image/webp' },
    { url: `${base}&revision=${revisionId}`, alt: 'x', mimeType: 'image/webp' },
    { url: base, alt: 'x', mimeType: 'image/svg+xml' },
  ]) assert.equal(validOaChatImage(image), false);
});
