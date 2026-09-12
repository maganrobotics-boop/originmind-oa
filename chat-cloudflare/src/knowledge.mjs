import { PublicError } from "./errors.mjs";

function normalizedKey(value) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
}

export function displayKnowledgeTitle(item) {
  return [
    item.title,
    item.sectionTitle && normalizedKey(item.sectionTitle) !== normalizedKey(item.title) ? item.sectionTitle : "",
    item.paragraphRef,
    item.sourceLabel ? `来源：${item.sourceLabel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function fallbackAnswer(documents) {
  if (!documents.length) {
    return "经 OA 审核公开的资料中暂未找到足够依据。你可以补充问题背景，或点击“提交咨询”留下希望沟通的事项，由团队负责人确认。";
  }
  const excerpts = documents
    .map((document, index) => `[${String(index + 1)}] ${document.title}\n${document.body.slice(0, 1_100)}`)
    .join("\n\n");
  return `当前提供资料检索，以下是经 OA 审核公开的相关资料摘录：\n\n${excerpts}\n\n如需确认当前安排，请点击“提交咨询”，由团队负责人进一步处理。`;
}

export function safeSourceUrl(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PublicError("资料链接须为 http 或 https 地址");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new PublicError("资料链接须为 http 或 https 地址");
  }
  return url.toString();
}

export function aliyunEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PublicError("请输入阿里云百炼 HTTPS 接入地址");
  }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw new PublicError("请输入阿里云百炼 HTTPS 接入地址");
  }
  if (host !== "dashscope.aliyuncs.com" && !/^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/u.test(host)) {
    throw new PublicError("当前仅支持百炼北京地域");
  }
  if (url.pathname !== "/compatible-mode/v1" && url.pathname !== "/compatible-mode/v1/") {
    throw new PublicError("地址应以 /compatible-mode/v1 结尾");
  }
  return `${url.origin}/compatible-mode/v1`;
}
