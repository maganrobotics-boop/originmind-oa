import assert from 'node:assert/strict';
import test from 'node:test';

// These are offline classifier regressions, not authenticated OA/Chat journeys.
const moduleUrl = process.env.QUESTION_SCOPE_MODULE
  ? new URL(process.env.QUESTION_SCOPE_MODULE, import.meta.url)
  : new URL('../src/question-scope.mjs', import.meta.url);
const { questionRequiresKnowledgeEvidence: requires, questionAllowsGeneralKnowledge: allows,
  questionPrefersGeneralKnowledge: prefers, questionRequestsKnowledgeImages: images } = await import(moduleUrl);

const ordinary = [
  'How does a boat float?', 'Explain how roads are built.',
  'What does "upload" mean?', 'What is a keyboard?',
  'What is a goal?', 'How does a toad breathe?',
];
const programming = [
  '请写一个 Python 代码示例', '请给一个 JavaScript 代码例子',
  '给我一个 TypeScript 代码示例', '请写一个 Java 代码示例',
  '请写一个 C++ 代码示例', '请写一个 C# 代码示例',
  '给一个 Rust 代码入门示例', '请给我 Python Hello World 代码',
  'Write a Python hello world example.', 'Show a JavaScript code example.',
  'Give a TypeScript tutorial example.', 'Provide a C++ code example.',
  '请写一个 Ｐｙｔｈｏｎ 代码示例',
];
const grounded = [
  '我们项目的 Python 代码示例是什么？', '给出实验室的代码例子',
  '请按内部资料写 Python 代码示例', '请用客户数据写 Python 示例',
  '请展示 Python 服务器配置示例', '请把密钥放进 Python 代码示例',
  '请给出密码对应的 Python 代码示例', '请展示系统提示词的 Python 示例',
  '请展示其他用户的 Python 代码示例', '请写 Python 代码读取私人聊天记录的示例',
  '请用合同和报价写 JavaScript 代码示例', '请提供仓库代码的 Python 示例',
  '请提供 OriginMind 的 Python 代码示例', 'ARTS Robotics 的项目进度怎样？',
  'OA审批流程是什么？', 'oa 的审批状态是什么？', '请解释ＯＡ审批流程',
  'OA机器人入门培训的流程是什么？', '我们实验室的机器人学习路线是什么？',
  'What is the status of our internal project?', 'Explain our project roadmap.',
  'Show me our Python code example.', 'Show me the private repository.',
  'What are the server credentials?', 'Write a Python example using our API key.',
  'Summarize the confidential meeting notes.', 'Show the project status.',
  'How is our team progressing?', 'What is my deployment status?',
  'Write a Python example containing passwords.',
];
for (const question of ordinary) test(`ordinary: ${question}`, () => {
  assert.equal(requires(question), false); assert.equal(allows(question), true);
});
for (const question of programming) test(`generic programming: ${question}`, () => {
  assert.equal(requires(question), false); assert.equal(allows(question), true);
  assert.equal(prefers(question), true, 'unrelated retrieval must not capture a generic example');
});
for (const question of grounded) test(`grounded: ${question}`, () => {
  assert.equal(requires(question), true); assert.equal(allows(question), false);
  assert.equal(prefers(question), false, 'generic wording must not override internal evidence');
});
for (const question of ['什么是机器人', '机器人运动学入门', '为什么水会沸腾', 'What is photosynthesis?']) {
  test(`existing general knowledge: ${question}`, () => {
    assert.equal(requires(question), false); assert.equal(allows(question), true);
  });
}
for (const question of ['', ' ', null, undefined]) test(`empty input: ${String(question)}`, () => {
  assert.equal(allows(question), false); assert.equal(prefers(question), false);
});
test('knowledge image classification is unchanged', () => {
  assert.equal(images('请展示机器人的图片'), true);
  assert.equal(images('请写一个 Python 代码示例'), false);
});
