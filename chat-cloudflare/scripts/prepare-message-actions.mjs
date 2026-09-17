// One-time, branch-only integration. Fail closed if the inspected source anchors changed.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const appPath = new URL('../frontend/app.js', import.meta.url);
let app = await readFile(appPath, 'utf8');
function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw Error(`Expected one integration anchor: ${before.slice(0, 100)}`);
  return text.replace(before, after);
}
if (!app.includes('function editChatQuestion(')) {
  const bytes = Buffer.from(app);
  const sha = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  if (sha !== '6d10980fd40d060194fb5ab3d095be20d94d92e9') throw Error('Frontend changed since inspection; reconcile before applying.');
  app = replaceOnce(app, 'return images.length ? { images } : {};', `return {
    ...(images.length ? { images } : {}),
    ...(message?.role === "assistant" && message.publicSources === true ? { publicSources: true } : {}),
  };`);
  app = replaceOnce(app, '...knowledgeImageFields({ role: "assistant", images: payload.images }),', `...knowledgeImageFields({
          role: "assistant", images: payload.images,
          publicSources: payload.oaPublicStatus === "connected" && Array.isArray(payload.sources) && payload.sources.length > 0,
        }),`);
  const start = app.indexOf('  async function copyAnswer(content, conversationId) {');
  const end = app.indexOf('  function dispatchQuestion(', start);
  if (start < 0 || end <= start) throw Error('Message renderer anchors missing');
  app = app.slice(0, start) + `  async function copyAnswer(content, conversationId, label = "回答") {
    const session = conversationFor(conversationId);
    if (!session) return;
    try {
      await writeMessageClipboard(content);
      session.notice = \`已复制\${label}\`;
    } catch (error) {
      session.notice = error.message || "无法自动复制，请长按选择文字。";
    }
    if (state.activeConversationId === conversationId) syncFeedback();
  }

  function editChatQuestion(message, conversationId, opener) {
    const session = conversationFor(conversationId);
    if (!session || session.sending) return;
    openQuestionEditor(String(message.content || ""), opener, (question) => {
      const current = conversationFor(conversationId);
      const index = current?.messages.indexOf(message) ?? -1;
      if (!current || current.sending || index < 0 || state.activeConversationId !== conversationId) {
        throw new Error("当前聊天已变化，请关闭编辑窗口后重试。");
      }
      // Editing forks the prefix, never deletes the original thread and never reuses its signed token.
      const branch = createConversation(current.section);
      branch.messages = current.messages.slice(0, index).map((turn) => ({ ...turn }));
      branch.conversationToken = "";
      branch.tokenSavedAt = 0;
      branch.draft = question;
      activateConversation(branch.id, { historyMode: "push" });
      dispatchQuestion(question, branch.id);
    });
  }

  function assistantMessageNode(message, conversationId) {
    const article = element("article", {
      className: \`message \${message.role}\`,
      attributes: {
        "aria-label": message.role === "user" ? "你发送的消息" : \`\${APP_NAME} 的回答\`,
        tabindex: "-1",
      },
    });
    const answer = message.role === "assistant"
      ? userFacingAnswer(message.content)
      : String(message.content || "");
    article.append(message.role === "assistant"
      ? renderAnswerBody(answer)
      : element("div", { className: "message-body", text: answer }));

    if (message.role === "assistant") {
      if (validatedKnowledgeImages(message.images).length) article.append(renderKnowledgeImages(message.images));
      const actions = element("div", { className: "message-actions", attributes: { role: "group", "aria-label": "回答操作" } });
      const share = (opener, intent) => {
        const session = conversationFor(conversationId);
        const index = session?.messages.indexOf(message) ?? -1;
        if (index < 0) return;
        const question = session.messages.slice(0, index).findLast((turn) => turn.role === "user")?.content || "";
        openAnswerShare({ v: 1, question: String(question), answer }, opener, intent);
      };
      const copy = messageActionButton("复制回答", "copy", "copy-answer", () => void copyAnswer(answer, conversationId));
      const copyLink = messageActionButton("复制链接", "link", "copy-answer-link", (event) => share(event.currentTarget, "copy"));
      const shareLink = messageActionButton("分享链接", "share", "share-answer", (event) => share(event.currentTarget, "share"));
      actions.append(copy, copyLink, shareLink);
      if (message.publicSources === true) {
        actions.append(element("span", { className: "message-source-note", text: "参考内部公开资料" }));
      }
      article.append(actions);
    } else if (message.role === "user") {
      installQuestionActions(article, answer,
        (opener) => editChatQuestion(message, conversationId, opener),
        () => copyAnswer(answer, conversationId, "提问"));
    }
    return article;
  }

` + app.slice(end);
  await writeFile(appPath, app);
}
const buildPath = new URL('./build-frontend.mjs', import.meta.url);
let build = await readFile(buildPath, 'utf8');
if (!build.includes('messageActions: join(')) {
  build = replaceOnce(build, '  app: join(FRONTEND_DIRECTORY, "app.js"),', '  app: join(FRONTEND_DIRECTORY, "app.js"),\n  messageActions: join(FRONTEND_DIRECTORY, "message-actions.js"),\n  messageActionStyle: join(FRONTEND_DIRECTORY, "message-actions.css"),');
  build = replaceOnce(build, 'const [template, appSource, style, zipImportAddon, math, imageReferencesModule]', 'const [template, appSource, baseStyle, zipImportAddon, math, imageReferencesModule, messageActions, actionStyle]');
  build = replaceOnce(build, '    readFile(SOURCE_PATHS.knowledgeImageReferences, "utf8"),', '    readFile(SOURCE_PATHS.knowledgeImageReferences, "utf8"),\n    readFile(SOURCE_PATHS.messageActions, "utf8"),\n    readFile(SOURCE_PATHS.messageActionStyle),');
  build = replaceOnce(build, '  const app = Buffer.from(replaceExactlyOnce(appSource.toString("utf8"), "__KATEX_ASSET__", `/assets/${mathName}`), "utf8");', '  const app = Buffer.from(`${messageActions}\\n${replaceExactlyOnce(appSource.toString("utf8"), "__KATEX_ASSET__", `/assets/${mathName}`)}\\nvoid openIncomingSharedAnswer();\\n`, "utf8");\n  const style = Buffer.concat([baseStyle, Buffer.from("\\n"), actionStyle]);');
  await writeFile(buildPath, build);
}
const packagePath = new URL('../package.json', import.meta.url);
let packageText = await readFile(packagePath, 'utf8');
if (!packageText.includes('node --check frontend/message-actions.js')) {
  packageText = replaceOnce(packageText, 'node --check frontend/app.js &&', 'node --check frontend/app.js && node --check frontend/message-actions.js &&');
  await writeFile(packagePath, packageText);
}
const checkPath = new URL('../../.github/workflows/check-chat-cloudflare.yml', import.meta.url);
let check = await readFile(checkPath, 'utf8');
if (!check.includes('check-message-actions-browser.mjs')) {
  check = replaceOnce(check, '          node chat-cloudflare/scripts/check-answer-browser.mjs', '          node chat-cloudflare/scripts/check-answer-browser.mjs\n          node chat-cloudflare/scripts/check-message-actions-browser.mjs');
  await writeFile(checkPath, check);
}
console.log('Message action integration prepared; no production resources changed.');
