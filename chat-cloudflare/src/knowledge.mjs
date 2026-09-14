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
    return "目前没有足够信息回答这个问题。你可以补充具体方向、对象或时间范围；如需团队确认，请点击“提交咨询”。";
  }
  const excerpts = [];
  const seen = new Set();
  for (const document of documents) {
    const clean = typeof document?.body === "string"
      ? document.body
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
      : "";
    const key = clean.normalize("NFKC").toLocaleLowerCase("zh-CN");
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    const characters = Array.from(clean);
    excerpts.push(characters.length > 520 ? `${characters.slice(0, 519).join("")}…` : clean);
    if (excerpts.length === 3) break;
  }
  if (!excerpts.length) {
    return "目前没有足够信息回答这个问题。你可以补充具体方向、对象或时间范围；如需团队确认，请点击“提交咨询”。";
  }
  if (excerpts.length === 1) return excerpts[0];
  return `知识库中与这个问题直接相关的内容包括：\n\n${excerpts.map((excerpt) => `- ${excerpt}`).join("\n")}`;
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
