"""Run with --reference to verify the example, otherwise check exercise.py."""
import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from analyze import load_log

USE_REFERENCE = "--reference" in sys.argv
if USE_REFERENCE:
    sys.argv.remove("--reference")
summarize = importlib.import_module("analyze" if USE_REFERENCE else "exercise").summarize
DATA = Path(__file__).parent / "data"


def row(time, x, y=0, battery=90):
    return {"time": time, "x": x, "y": y, "yaw": 0, "battery": battery}


class LessonChecks(unittest.TestCase):
    def test_01_square(self):
        result = summarize(load_log(DATA / "motion_log.csv"))
        for key, expected in {"samples": 21, "duration_s": 20, "distance_m": 10,
                              "mean_speed_mps": 0.5, "max_speed_mps": 0.5,
                              "displacement_m": 0, "battery_drop_pp": 5}.items():
            self.assertAlmostEqual(result[key], expected, places=6)
        self.assertEqual(result["suspicious"], [])

    def test_02_diagonal(self):
        result = summarize([row(0, 0), row(2, 3, 4, 89)])
        self.assertAlmostEqual(result["distance_m"], 5)
        self.assertAlmostEqual(result["mean_speed_mps"], 2.5)
        self.assertAlmostEqual(result["battery_drop_pp"], 1)

    def test_03_stationary(self):
        result = summarize([row(0, 2, 3), row(5, 2, 3)])
        self.assertEqual(result["distance_m"], 0)
        self.assertEqual(result["max_speed_mps"], 0)
        self.assertEqual(result["suspicious"], [])

    def test_04_irregular_sampling(self):
        result = summarize([row(0, 0), row(1, 1), row(4, 2)])
        self.assertAlmostEqual(result["mean_speed_mps"], 0.5)
        self.assertAlmostEqual(result["duration_s"], 4)

    def test_05_position_jump(self):
        result = summarize(load_log(DATA / "position_jump.csv"))
        self.assertAlmostEqual(result["distance_m"], 11)
        self.assertEqual(result["suspicious"], [{"start": 1, "end": 2, "speed": 10}])

    def test_06_threshold(self):
        self.assertEqual(summarize([row(0, 0), row(1, 1.5)])["suspicious"], [])
        for value in (0, -1, float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                summarize([row(0, 0), row(1, 1)], value)

    def test_07_bad_time_and_short_log(self):
        for body in ("time,x,y,yaw,battery\n0,0,0,0,90\n0,1,0,0,89\n",
                     "time,x,y,yaw,battery\n0,0,0,0,90\n",
                     "time,x,y,yaw,battery\n2,0,0,0,90\n1,1,0,0,89\n"):
            self.check_invalid(body)

    def test_08_bad_fields(self):
        for body in ("time,x,y\n0,0,0\n1,1,0\n",
                     "time,x,y,yaw,battery\n0,0,0,0,90\n1,nan,0,0,89\n",
                     "time,x,y,yaw,battery\n0,0,0,0,101\n1,1,0,0,90\n",
                     "time,x,y,yaw,battery\n0,0,0,0,90\n1,,0,0,89\n"):
            self.check_invalid(body)

    def check_invalid(self, body):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "invalid.csv"
            path.write_text(body, encoding="utf-8")
            with self.assertRaises(ValueError):
                load_log(path)


if __name__ == "__main__":
    print("检查对象：{}；通过自检不等于教师审核通过。".format("参考程序" if USE_REFERENCE else "我的练习"))
    unittest.main(verbosity=2)
