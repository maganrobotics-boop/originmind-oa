"""Measure a full-circle pose recording; does not establish its provenance."""
import argparse
import csv
import math
import sys
from pathlib import Path


def check(path, radius=1.0):
    with Path(path).open(encoding="utf-8-sig", newline="") as handle:
        rows = [{k: float(row[k]) for k in ("time", "x", "y", "theta")} for row in csv.DictReader(handle)]
    if len(rows) < 40 or not all(math.isfinite(v) for row in rows for v in row.values()):
        raise ValueError("需要至少 40 行有效 pose 数据")
    if any(b["time"] <= a["time"] for a, b in zip(rows, rows[1:])):
        raise ValueError("时间必须严格递增")
    duration = rows[-1]["time"]-rows[0]["time"]
    distance = sum(math.hypot(b["x"]-a["x"], b["y"]-a["y"]) for a, b in zip(rows, rows[1:]))
    closure = math.hypot(rows[-1]["x"]-rows[0]["x"], rows[-1]["y"]-rows[0]["y"])
    width = max(r["x"] for r in rows)-min(r["x"] for r in rows)
    height = max(r["y"] for r in rows)-min(r["y"] for r in rows)
    errors = []
    if not 6.0 <= duration <= 7.2:
        errors.append("时长不在 6.0–7.2 s；检查 DURATION、启动顺序和停止条件")
    if abs(distance-2*math.pi*radius) > 0.5:
        errors.append("累计路程与整圆理论值相差超过 0.5 仿真单位")
    if closure > 0.35:
        errors.append("起终点偏差超过 0.35；检查初始状态或命令丢失")
    if abs(width-2*radius) > 0.35 or abs(height-2*radius) > 0.35:
        errors.append("轨迹外接框不符合目标圆径；检查是否撞墙或走错路径")
    return {"samples": len(rows), "duration": duration, "distance": distance, "closure": closure, "width": width, "height": height}, errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("csv")
    parser.add_argument("--radius", type=float, default=1.0)
    args = parser.parse_args()
    if not math.isfinite(args.radius) or args.radius <= 0:
        parser.error("radius 必须为正数")
    try:
        result, errors = check(args.csv, args.radius)
        for key, value in result.items():
            print(f"{key}={value:.3f}")
        print("\n".join(errors) if errors else "轨迹指标通过；仍需 ROS2 节点/话题截图及原始运行证据。")
        sys.exit(bool(errors))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("无法检查：", error)
        sys.exit(2)
