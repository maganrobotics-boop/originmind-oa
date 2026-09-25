"""Newbie lesson: synthetic robot log analysis, Python standard library only."""
import argparse
import csv
import math
import sys
from pathlib import Path

FIELDS = ("time", "x", "y", "yaw", "battery")


def load_log(path):
    rows = []
    with Path(path).open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or not set(FIELDS).issubset(reader.fieldnames):
            raise ValueError("CSV 必须包含 time,x,y,yaw,battery 五列。")
        for line, raw in enumerate(reader, start=2):
            try:
                row = {key: float(raw[key]) for key in FIELDS}
            except (TypeError, ValueError) as error:
                raise ValueError("第 {} 行有空值或非数字。".format(line)) from error
            if not all(math.isfinite(value) for value in row.values()):
                raise ValueError("第 {} 行包含 NaN 或无穷值。".format(line))
            if not 0 <= row["battery"] <= 100:
                raise ValueError("第 {} 行电量必须在 0 到 100 之间。".format(line))
            if rows and row["time"] <= rows[-1]["time"]:
                raise ValueError("第 {} 行时间必须大于上一行，不能重复或倒退。".format(line))
            rows.append(row)
    if len(rows) < 2:
        raise ValueError("至少需要两个采样点。")
    return rows


def summarize(rows, threshold=1.5):
    if not math.isfinite(threshold) or threshold <= 0:
        raise ValueError("阈值必须是大于 0 的有限数。")
    distances = []
    speeds = []
    suspicious = []
    for before, after in zip(rows, rows[1:]):
        distance = math.hypot(after["x"] - before["x"], after["y"] - before["y"])
        speed = distance / (after["time"] - before["time"])
        distances.append(distance)
        speeds.append(speed)
        if speed > threshold:
            suspicious.append({"start": before["time"], "end": after["time"], "speed": speed})
    duration = rows[-1]["time"] - rows[0]["time"]
    distance = sum(distances)
    return {
        "samples": len(rows),
        "duration_s": duration,
        "distance_m": distance,
        "mean_speed_mps": distance / duration,
        "max_speed_mps": max(speeds),
        "displacement_m": math.hypot(rows[-1]["x"] - rows[0]["x"], rows[-1]["y"] - rows[0]["y"]),
        "battery_drop_pp": rows[0]["battery"] - rows[-1]["battery"],
        "suspicious": suspicious,
    }


def report(result, threshold):
    print("采样点：{}".format(result["samples"]))
    for label, key, unit in (
        ("记录时长", "duration_s", "s"),
        ("累计路程", "distance_m", "m"),
        ("平均速率", "mean_speed_mps", "m/s"),
        ("最大分段速率", "max_speed_mps", "m/s"),
        ("起终点位移", "displacement_m", "m"),
    ):
        print("{}：{:.3f} {}".format(label, result[key], unit))
    print("电量下降：{:.2f} 个百分点".format(result["battery_drop_pp"]))
    print("可疑分段：{}（阈值 {:.3f} m/s）".format(len(result["suspicious"]), threshold))
    for segment in result["suspicious"]:
        print("  {:.3f} 至 {:.3f} s：{:.3f} m/s".format(segment["start"], segment["end"], segment["speed"]))


def run_cli(analyzer=summarize):
    parser = argparse.ArgumentParser(description="分析教学用机器人日志；不控制任何设备。")
    parser.add_argument("path", nargs="?", default=str(Path(__file__).parent / "data" / "motion_log.csv"))
    parser.add_argument("--threshold", type=float, default=1.5, help="可疑分段速率阈值，单位 m/s")
    args = parser.parse_args()
    try:
        report(analyzer(load_log(args.path), args.threshold), args.threshold)
    except (OSError, ValueError, NotImplementedError) as error:
        print("未完成分析：{}".format(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(run_cli())
