"""Optional local structure check; does not verify identity or enroll a member."""
import json
import math
import sys
from pathlib import Path


def filled(value):
    return isinstance(value, str) and bool(value.strip()) and "待填写" not in value


def hours(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 < value <= 40


def validate(data):
    errors = []
    if not isinstance(data, dict):
        return ["资料必须是 JSON 对象"]
    for key in ("display_name", "major", "year", "goal", "help_needed"):
        if not filled(data.get(key)):
            errors.append(key + " 未填写（不需要帮助可写‘暂不需要’）")
    if data.get("direction") not in ("undecided", "perception", "navigation", "control", "mechanics", "embedded", "ai"):
        errors.append("direction 必须使用教程中的方向代码")
    skills = data.get("skills")
    if not isinstance(skills, list) or not skills or not all(filled(x) for x in skills):
        errors.append("skills 至少写一项当前基础，也可写‘零基础’")
    if not hours(data.get("weekly_hours")):
        errors.append("weekly_hours 应为 0–40 之间的正数；按自己的实际可用时间填写")
    plans = data.get("week_plan")
    if not isinstance(plans, list) or not plans:
        errors.append("week_plan 至少安排一项任务")
    else:
        valid = all(isinstance(p, dict) and filled(p.get("task")) and filled(p.get("evidence")) and hours(p.get("hours")) for p in plans)
        if not valid:
            errors.append("每项计划需有 task、正数 hours 和具体 evidence")
        elif hours(data.get("weekly_hours")) and sum(p["hours"] for p in plans) > data["weekly_hours"]:
            errors.append("计划总时长超过每周可投入时间")
    return errors


if __name__ == "__main__":
    try:
        data = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else "profile.json").read_text(encoding="utf-8-sig"))
        errors = validate(data)
        print("\n".join(errors) if errors else "资料结构检查通过；方向匹配仍需本人和导师讨论。")
        sys.exit(bool(errors))
    except (OSError, ValueError) as error:
        print("无法检查：", error)
        sys.exit(2)
