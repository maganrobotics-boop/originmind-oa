"""Implement BFS; use planner.py only after attempting the task."""
from collections import deque
from planner import run


def shortest_path(grid, start, goal):
    # TODO 1: 初始化队列与 parents；把起点标为已访问。
    # TODO 2: 逐层扩展四邻域；禁止越界、穿过 # 和重复访问。
    # TODO 3: 找到终点时沿 parents 回溯；无路时返回 None。
    raise NotImplementedError("请完成 shortest_path 的三个 TODO")


if __name__ == "__main__":
    raise SystemExit(run(shortest_path))
