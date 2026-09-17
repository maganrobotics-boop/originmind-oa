import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = 'https://chat.omindos.ai';
const sha = '23c0146f19f4aaec9da61e976979ce7235777ee3';
const expectedRelease = `${sha}-1`;
const repo = 'maganrobotics-boop/originmind-oa';
const runs = [35175736950, 35175798259];
const out = 'live-acceptance-evidence';
const evidence = { format: 'originmind-public-live-acceptance-v1', startedAt: new Date().toISOString(), expectedRelease, writesToKnowledgeOrConfiguration: false, probes: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(out, { recursive: true });

async function waitForDeployments() {
  assert(process.env.ACTIONS_READ_TOKEN, 'A read-only Actions token is required to verify the exact release runs');
  for (let attempt = 0; attempt < 40; attempt++) {
    const states = [];
    for (const id of runs) {
      const r = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${id}`, {
        headers: { Authorization: `Bearer ${process.env.ACTIONS_READ_TOKEN}`, Accept: 'application/vnd.github+json' },
        redirect: 'error', signal: AbortSignal.timeout(20000),
      });
      assert.equal(r.status, 200, 'Could not read an authorized deployment run');
      const j = await r.json();
      assert.equal(j.head_sha, sha, 'Deployment SHA changed');
      states.push({ id, status: j.status, conclusion: j.conclusion, headSha: j.head_sha });
      if (j.status === 'completed') assert.equal(j.conclusion, 'success', `Deployment ${id} did not succeed`);
    }
    evidence.deploymentRuns = states;
    if (states.every(s => s.status === 'completed')) return;
    console.log(`Waiting for the two authorized release runs; check ${attempt + 1}/40`);
    await sleep(30000);
  }
  throw new Error('The authorized release runs did not finish within 20 minutes');
}
async function request(path, body) {
  const target = new URL(path, origin);
  assert.equal(target.origin, origin, 'Only the exact public Chat origin may be probed');
  return fetch(target, {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'OriginMind-Chat-Release-Smoke/LiveAcceptance-20260917', ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(body ? 85000 : 25000),
  });
}
async function jsonRequest(path, body) {
  const start = Date.now();
  const r = await request(path, body);
  assert.equal(r.status, 200, `${body ? 'Chat' : path} HTTP status was not 200`);
  assert.match(r.headers.get('content-type') || '', /application\/json/i);
  const text = await r.text();
  assert(text.length <= 1000000, 'Unexpectedly large JSON response');
  return { data: JSON.parse(text), durationMs: Date.now() - start, serverTiming: r.headers.get('server-timing') };
}
function imageSignature(b, mime) {
  if (mime === 'image/png') return b.length >= 8 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/jpeg') return b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  return mime === 'image/webp' && b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP';
}
async function verifyImage(image) {
  assert.match(image.url, /^\/api\/knowledge\/assets\/v1_[A-Za-z0-9_-]{80,320}$/);
  const r = await request(image.url);
  assert.equal(r.status, 200, 'An associated knowledge image could not be read');
  const mime = (r.headers.get('content-type') || '').split(';')[0];
  assert.equal(mime, image.mimeType, 'Image MIME mismatch');
  assert.match(r.headers.get('cache-control') || '', /no-store/i);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const b = Buffer.from(await r.arrayBuffer());
  assert(b.length > 12 && b.length <= 8 * 1024 * 1024, 'Image size outside the supported bound');
  assert(imageSignature(b, mime), 'The image body was not valid for its declared format');
  return { alt: image.alt, mimeType: mime, httpStatus: r.status, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex'), noStore: true };
}
function safeChat(j, timing, question) {
  assert.equal(j.releaseId, expectedRelease, 'The public answer came from a different release');
  assert.equal(j.oaPublicStatus, 'connected', 'OA public retrieval is not connected');
  assert.equal(typeof j.answer, 'string', 'Answer is missing');
  return { question, ...timing, releaseId: j.releaseId, mode: j.mode, provider: j.provider || null,
    answer: j.answer, answerCharacters: [...j.answer].length, endsWithSentencePunctuation: /[。！？.!?][\s*_`]*$/u.test(j.answer),
    containsReplacementCharacter: j.answer.includes('\ufffd'), explicitIncompleteNotice: j.answer.includes('尚未完整生成'),
    sources: (j.sources || []).map(s => ({ title: s.title, excerpt: s.excerpt })),
    returnedImageCount: (j.images || []).length, verifiedImages: [] };
}

try {
  await waitForDeployments();
  delete process.env.ACTIONS_READ_TOKEN;
  const health = await jsonRequest('/_health');
  assert.equal(health.data.releaseId, expectedRelease, 'Production release ID mismatch');
  evidence.health = health.data;
  const q1 = '请展示差速轮式小车实验平台正视与侧视图，并根据资料说明平台集成的激光雷达、相机、计算单元和底盘。';
  const first = await jsonRequest('/api/chat', { topic: 'research', messages: [{ role: 'user', content: q1 }] });
  const firstProbe = safeChat(first.data, { durationMs: first.durationMs, serverTiming: first.serverTiming }, q1);
  evidence.probes.push(firstProbe);
  for (const image of (first.data.images || []).slice(0,4)) firstProbe.verifiedImages.push(await verifyImage(image));
  firstProbe.associatedImagesReadable = firstProbe.verifiedImages.length > 0 && firstProbe.verifiedImages.length === firstProbe.returnedImageCount;
  const invalid = await request('/api/knowledge/assets/not-a-valid-token');
  evidence.invalidImageTokenRejected = invalid.status === 404;
  await invalid.body?.cancel();
  if (first.data.images?.length) {
    const url = first.data.images[0].url;
    const i = url.indexOf('v1_') + 10;
    const tampered = url.slice(0,i) + (url[i] === 'A' ? 'B' : 'A') + url.slice(i+1);
    const denied = await request(tampered);
    evidence.tamperedImageTokenRejected = denied.status === 404;
    await denied.body?.cancel();
  }
  const q2 = '请根据现有公开资料，详细介绍差速轮式小车实验平台及其室内定位、建图和语义导航研究。从平台组成、传感器作用、算法流程、实验设置、结果和局限逐项说明，尽量写到1200至1800字并完整结束；资料没有的参数和结果请明确说明，不要编造。';
  const second = await jsonRequest('/api/chat', { topic: 'research', messages: [{ role: 'user', content: q2 }] });
  const secondProbe = safeChat(second.data, { durationMs: second.durationMs, serverTiming: second.serverTiming }, q2);
  evidence.probes.push(secondProbe);
  for (const image of (second.data.images || []).slice(0,4)) secondProbe.verifiedImages.push(await verifyImage(image));
  evidence.status = (await jsonRequest('/api/status')).data;
  evidence.imageAcceptance = firstProbe.associatedImagesReadable ? 'associated-images-read-successfully' : 'no-associated-images-returned';
  evidence.longAnswerObservation = secondProbe.mode === 'ai' && secondProbe.answerCharacters >= 900 && secondProbe.endsWithSentencePunctuation && !secondProbe.containsReplacementCharacter && !secondProbe.explicitIncompleteNotice ? 'long-answer-observed-with-sentence-ending' : 'needs-review';
  evidence.completedAt = new Date().toISOString();
  await writeFile(`${out}/result.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  assert(evidence.invalidImageTokenRejected, 'An invalid image token was not rejected');
  assert.notEqual(evidence.tamperedImageTokenRejected, false, 'A modified image token was not rejected');
  assert(firstProbe.associatedImagesReadable, 'No readable associated image was returned for the requested platform');
  assert.equal(evidence.status.systemReady, true, 'System status was not ready after real question probes');
} catch (error) {
  evidence.failedAt = new Date().toISOString();
  evidence.error = error instanceof Error ? error.message : 'Acceptance failed';
  await writeFile(`${out}/result.json`, JSON.stringify(evidence, null, 2));
  console.error(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
}
