"""Analytic data for learning/checker tests, NOT a ROS2 execution log."""
import csv
import math
import sys
from pathlib import Path
from motion import LINEAR, ANGULAR, DURATION, expected

if not math.isfinite(ANGULAR) or ANGULAR == 0 or not math.isfinite(LINEAR) or not math.isfinite(DURATION) or DURATION <= 0:
    raise SystemExit("本练习要求有限速度、非零角速度及正时长")
output = Path(sys.argv[1] if len(sys.argv) > 1 else "synthetic_pose.csv")
with output.open("x", newline="", encoding="utf-8") as handle:
    writer = csv.writer(handle)
    writer.writerow(["time", "x", "y", "theta"])
    for i in range(201):
        t = DURATION * i / 200
        writer.writerow([t, 5.544 + LINEAR/ANGULAR*math.sin(ANGULAR*t), 5.544 + LINEAR/ANGULAR*(1-math.cos(ANGULAR*t)), math.atan2(math.sin(ANGULAR*t), math.cos(ANGULAR*t))])
print("SYNTHETIC_ONLY：理论轨迹已写入", output)
print(expected())
