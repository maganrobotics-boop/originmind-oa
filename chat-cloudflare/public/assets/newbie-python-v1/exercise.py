"""Complete this function. Keep the input/output contract for check_work.py."""
import math
import sys
from analyze import run_cli


def summarize(rows, threshold=1.5):
    # load_log has already checked column values and strictly increasing time.
    # TODO 1: reject a non-finite or non-positive threshold with ValueError.
    # TODO 2: iterate over adjacent rows; collect distances, speeds, and
    #         suspicious segments where speed > threshold.
    # TODO 3: return this dictionary, with your own computed values:
    # {
    #   "samples": len(rows), "duration_s": ..., "distance_m": ...,
    #   "mean_speed_mps": ..., "max_speed_mps": ..., "displacement_m": ...,
    #   "battery_drop_pp": ...,
    #   "suspicious": [{"start": ..., "end": ..., "speed": ...}, ...]
    # }
    # Empty suspicious list means no segment exceeded the threshold.
    raise NotImplementedError("请按教程完成 exercise.py 的三个 TODO，再运行自检。")


if __name__ == "__main__":
    sys.exit(run_cli(summarize))
