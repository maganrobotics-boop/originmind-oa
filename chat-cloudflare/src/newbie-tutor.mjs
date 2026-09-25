import { NEWBIE_COURSES } from "./newbie-course-data.mjs";

// Course selection chooses only public curriculum. It grants no permissions
// and never promotes student-supplied text into the reference document.
export function newbieCourseDocument(messages = []) {
  for (const message of messages.slice(-8).reverse()) {
    if (message?.role !== "user") continue;
    const match = String(message.content || "").match(/^我正在学习新手村第 ([1-7]) 关：([^。\n]{1,40})。/u);
    if (!match) continue;
    const entry = Object.entries(NEWBIE_COURSES).find(([, course]) => course.index === Number(match[1]) && course.title === match[2]);
    if (!entry) continue;
    const [id, course] = entry;
    return {
      id: `course:${id}`,
      title: `新手村第 ${course.index} 关：${course.title}`,
      body: [`本关目标：${course.goal}`, "学习步骤：", ...course.steps,
        "验收与提交要求：", ...course.deliverables,
        "公开阅读和下载无需登录。助教应针对当前问题解释与排错，不能代替学生运行或教师验收。"].join("\n"),
      url: "", updatedAt: "2026-09-25", origin: "site_public",
      category: "公开课程", published: 1,
    };
  }
  return null;
}
