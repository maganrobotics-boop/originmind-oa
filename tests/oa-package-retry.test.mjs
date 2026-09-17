import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareKnowledgePackage, submitKnowledgePackage } from '../lib/knowledge-package.mjs';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const body = '# 上传重试测试\n资料必须完整提交且不能自动批准。\n![第一张](assets/one.png)\n![第二张](assets/two.png)';
const withImages = () => prepareKnowledgePackage([
  new File([body], 'index.md'),
  new File([png], 'assets/one.png'),
  new File([png], 'assets/two.png'),
]);
const received = data => Response.json({ received: true, ...data });

// Model the actual protocol: each import response has a new token, while a stored
// asset's token and bytes are immutable. An acknowledgement can be lost after commit.
function immutableAssetServer(failure) {
  const state = { imports: [], putTokens: [], finalizeTokens: [], assets: new Map(), failed: false, ready: false, itemId: 'item-one', revisionId: 'revision-one' };
  const fetcher = async (url, init) => {
    assert.equal(init.credentials, 'same-origin');
    assert.notEqual(init.method, 'PATCH', 'uploads must never approve knowledge');
    if (url === '/api/knowledge/import-chat') {
      state.imports.push(JSON.parse(init.body));
      return received({ item: { id: state.itemId, status: 'pending' }, assetUpload: { revisionId: state.revisionId, uploadToken: `fresh-token-${state.imports.length}` } });
    }
    if (url === '/api/knowledge/assets') {
      const path = init.headers['x-knowledge-asset-path'];
      const token = init.headers['x-knowledge-upload-token'];
      assert.equal(init.headers['x-knowledge-item-id'], state.itemId);
      assert.equal(init.headers['x-knowledge-revision-id'], state.revisionId);
      state.putTokens.push(token);
      if (failure === 'second-image' && path === 'assets/two.png' && !state.failed) {
        state.failed = true;
        return Response.json({ error: 'second image interrupted' }, { status: 503 });
      }
      const bytes = Buffer.from(await init.body.arrayBuffer());
      const existing = state.assets.get(path);
      if (existing && (existing.token !== token || !existing.bytes.equals(bytes))) {
        return Response.json({ error: 'immutable asset token or bytes changed' }, { status: 409 });
      }
      state.assets.set(path, { token, bytes });
      if (failure === 'image-ack' && !state.failed) {
        state.failed = true;
        throw new Error('image committed but acknowledgement lost');
      }
      return received({});
    }
    assert.equal(url, '/api/knowledge/assets/finalize');
    const manifest = JSON.parse(init.body);
    state.finalizeTokens.push(manifest.uploadToken);
    assert.ok(manifest.expectedPaths.length > 0, 'the real server rejects empty manifests');
    assert.deepEqual([...manifest.expectedPaths].sort(), [...state.assets.keys()].sort());
    if ([...state.assets.values()].some(asset => asset.token !== manifest.uploadToken)) {
      return Response.json({ error: 'manifest belongs to another upload' }, { status: 409 });
    }
    state.ready = true;
    if (failure === 'finalize-ack' && !state.failed) {
      state.failed = true;
      throw new Error('finalization committed but acknowledgement lost');
    }
    return received({ assetCount: state.assets.size });
  };
  return { state, fetcher };
}

for (const failure of ['second-image', 'image-ack', 'finalize-ack']) {
  test(`retry keeps the first asset token after ${failure}, even when import rotates it`, async () => {
    const pkg = await withImages();
    const { state, fetcher } = immutableAssetServer(failure);
    const progress = [];
    const options = { fetcher, onProgress: message => progress.push(message) };
    await assert.rejects(submitKnowledgePackage(pkg, options), /interrupted|acknowledgement lost/u);
    assert.ok(!progress.includes('已完整提交 OA 待审核'));
    const result = await submitKnowledgePackage(pkg, options);
    assert.equal(result.item.id, 'item-one');
    assert.equal(result.item.status, 'pending');
    assert.equal(state.ready, true);
    assert.equal(state.assets.size, 2);
    assert.deepEqual(state.imports.map(payload => payload.document.id), [pkg.id, pkg.id]);
    assert.deepEqual([...new Set(state.putTokens)], ['fresh-token-1']);
    assert.deepEqual([...new Set(state.finalizeTokens)], ['fresh-token-1']);
    assert.equal(result.assetUpload.uploadToken, 'fresh-token-1');
    assert.equal(progress.at(-1), '已完整提交 OA 待审核');
  });
}

for (const unreferencedImage of [false, true]) {
  test(`text-only content skips asset writes and empty finalization, unused image=${unreferencedImage}`, async () => {
    const files = [new File(['# 纯文字资料\n这条资料没有引用图片，但包含完整的研究说明和公式 $x^2$。'], 'index.md')];
    if (unreferencedImage) files.push(new File([png], 'assets/unused.png'));
    const pkg = await prepareKnowledgePackage(files);
    const calls = [];
    const result = await submitKnowledgePackage(pkg, { fetcher: async (url, init) => {
      calls.push(url);
      assert.equal(url, '/api/knowledge/import-chat');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(JSON.parse(init.body).document.body, pkg.body);
      return received({ item: { id: 'text-item', status: 'pending' } });
    } });
    assert.equal(result.item.status, 'pending');
    assert.deepEqual(calls, ['/api/knowledge/import-chat']);
    assert.equal(pkg.images.length, 0);
    assert.equal(pkg.unusedPaths.length, unreferencedImage ? 1 : 0);
  });
}

test('an image package still requires an acknowledged complete asset session', async () => {
  const pkg = await withImages();
  const calls = [];
  await assert.rejects(submitKnowledgePackage(pkg, { fetcher: async url => {
    calls.push(url);
    return received({ item: { id: 'item-one', status: 'pending' } });
  } }), /完整图片上传会话/u);
  assert.deepEqual(calls, ['/api/knowledge/import-chat']);
});

for (const field of ['itemId', 'revisionId']) {
  test(`a changed ${field} stops retries before any additional image write`, async () => {
    const pkg = await withImages();
    const { state, fetcher } = immutableAssetServer('second-image');
    await assert.rejects(submitKnowledgePackage(pkg, { fetcher }), /interrupted/u);
    const puts = state.putTokens.length;
    state[field] = 'different-current-value';
    await assert.rejects(submitKnowledgePackage(pkg, { fetcher }), /条目或版本已变化/u);
    assert.equal(state.putTokens.length, puts);
    assert.equal(state.finalizeTokens.length, 0);
  });
}

test('changing a pending package or returned-item target cannot reuse an asset session', async () => {
  const pkg = await withImages();
  const { state, fetcher } = immutableAssetServer('second-image');
  await assert.rejects(submitKnowledgePackage(pkg, { fetcher, returnedKnowledgeItemId: 'returned-one' }), /interrupted/u);
  assert.equal(state.imports[0].returnedKnowledgeItemId, 'returned-one');
  await assert.rejects(submitKnowledgePackage(pkg, { fetcher, returnedKnowledgeItemId: 'returned-two' }), /重试时改动/u);
  pkg.title = '更改后的标题';
  await assert.rejects(submitKnowledgePackage(pkg, { fetcher, returnedKnowledgeItemId: 'returned-one' }), /重试时改动/u);
  assert.equal(state.imports.length, 1, 'changed metadata must fail before another request');
});

test('changing image files after a failed attempt is rejected before any new request', async () => {
  const pkg = await withImages();
  const { state, fetcher } = immutableAssetServer('second-image');
  await assert.rejects(submitKnowledgePackage(pkg, { fetcher }), /interrupted/u);
  pkg.images[0].file = new File([png], 'assets/one.png');
  await assert.rejects(submitKnowledgePackage(pkg, { fetcher }), /重试时改动/u);
  assert.equal(state.imports.length, 1);
});
