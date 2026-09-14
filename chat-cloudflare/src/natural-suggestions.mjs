import { decryptSecret, encryptSecret } from "./crypto.mjs";
import { retrieveOa, suggestionKnowledgeReference, suggestionMatchesKnowledge } from "./oa-public.mjs";

const PURPOSE = "arts-public-suggestion-v1";
const TOKEN_TTL_MS = 10 * 60_000;

// Ask about concepts present in approved excerpts. Never interpolate upload
// titles, filenames, or arbitrary source text into a visitor-facing question.
// Specific questions take priority; unrecognized material is simply omitted.
const QUESTIONS = [
  [[/无\s*(?:GNSS|GPS)|没有卫星信号|无卫星信号/iu, /定位/u], "没有卫星信号时，机器人怎么定位？"],
  [[/RTK/iu, /激光雷达|LiDAR/iu, /惯性|IMU/iu], "激光雷达、惯性传感器和 RTK 如何协同定位？"],
  [[/触觉|tactile/iu, /抓取|抓握|操作|grasp|manipulation/iu], "触觉反馈能怎样帮助机器人抓稳物体？"],
  [[/视觉|vision/iu, /抓取|grasp/iu], "机器人怎样通过视觉找到并抓取物体？"],
  [[/双臂|dual.arm|bimanual/iu, /协作|协调|coordinat/iu], "两条机械臂怎样配合完成操作任务？"],
  [[/机械臂|机器人|robot/iu, /运动规划|motion planning/iu], "机器人怎样规划完成任务的动作轨迹？"],
  [[/四足/u, /矿井|矿区|井下/u, /巡检/u], "四足机器人能在矿井里完成哪些巡检任务？"],
  [[/矿井|矿区|井下/u, /巡检/u], "矿井巡检机器人主要检查哪些内容？"],
  [[/三维重建|3D reconstruction/iu], "机器人怎样把周围环境重建成三维地图？"],
  [[/自主导航/u, /避障|路径规划/u], "机器人怎样自主规划路线并避开障碍？"],
  [[/OriginMind|OmindOS|Robot Agent OS/iu, /技能|任务|调度/u], "OriginMind 怎样组织机器人的技能和任务？"],
  [[/语音/u, /导航|操作/u], "怎样让机器人听懂指令并执行任务？"],
  [[/故障|失败|退化/u, /恢复/u], "机器人遇到故障后怎样恢复任务？"],
  [[/灵巧操作|dexterous manipulation/iu], "让机器人完成灵巧操作，关键要解决哪些问题？"],
  [[/协作机器人/u, /安全/u], "人和协作机器人一起工作时，怎样保障安全？"],
  [[/协会/u, /活动|实践|竞赛/u], "协会有哪些机器人实践活动？"],
  [[/研究/u, /提出|方法/u], "这项研究主要解决什么问题？"],
  [[/项目|产品/u, /应用|场景/u], "这个项目适合用在哪些场景？"],
];

export function naturalQuestions(documents) {
  const excerpts = documents.map((document) => String(document.body || "")
    .normalize("NFKC")
    .split(/\n/u)
    .filter((line) => !/\.(?:pptx?|pdf|docx?|md)\b|文件名|源文件|脱敏|脱密/iu.test(line))
    .join(" "));
  return QUESTIONS.filter(([patterns]) => excerpts.some((excerpt) => patterns.every((pattern) => pattern.test(excerpt))))
    .map(([, question]) => question);
}

export function parseChatSuggestions(value) {
  if (!Array.isArray(value) || value.length > 4) throw new Error("INVALID_SUGGESTIONS");
  const seen = new Set();
  return value.map((item, index) => {
    if (!item || Object.keys(item).sort().join(",") !== "id,question,suggestionToken,updatedAt"
      || item.id !== String(index + 1) || !QUESTIONS.some(([, question]) => item.question === question)
      || seen.has(item.question) || !/^\d{4}-\d{2}-\d{2}$/u.test(item.updatedAt)
      || new Date(`${item.updatedAt}T00:00:00.000Z`).toISOString().slice(0, 10) !== item.updatedAt
      || typeof item.suggestionToken !== "string" || item.suggestionToken.length > 4_000
      || !/^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]+={0,2}$/u.test(item.suggestionToken)) {
      throw new Error("INVALID_SUGGESTIONS");
    }
    seen.add(item.question);
    return item;
  });
}

export async function naturalizeSuggestions(result, context, deadline = Date.now() + 13_000) {
  if (result.status !== "connected") return result;
  const candidates = await Promise.all(result.suggestions.map(async (suggestion) => {
    const retrieved = await retrieveOa(suggestion.question, context, Math.max(1, deadline - Date.now()));
    if (retrieved.status !== "connected") return null;
    const documents = retrieved.documents.filter((document) => suggestionMatchesKnowledge(suggestion.question, document));
    return { suggestion, questions: naturalQuestions(documents) };
  }));
  const suggestions = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const question = candidate?.questions.find((value) => !seen.has(value));
    if (!question) continue;
    seen.add(question);
    const suggestionToken = await encryptSecret(JSON.stringify({
      purpose: PURPOSE,
      question,
      retrievalQuestion: candidate.suggestion.question,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    }), context.env.APP_ENCRYPTION_KEY);
    suggestions.push({
      id: String(suggestions.length + 1),
      question,
      updatedAt: candidate.suggestion.updatedAt,
      suggestionToken,
    });
  }
  return { status: "connected", suggestions };
}

export async function suggestionRetrievalQuestion(token, question, secret) {
  try {
    const value = JSON.parse(await decryptSecret(token, secret));
    if (value.purpose !== PURPOSE || value.question !== question || !Number.isFinite(value.expiresAt)
      || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + TOKEN_TTL_MS
      || !suggestionKnowledgeReference(value.retrievalQuestion)) return null;
    return value.retrievalQuestion;
  } catch {
    return null;
  }
}
