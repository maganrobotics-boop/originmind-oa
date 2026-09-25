"""Four-neighbour unweighted BFS on synthetic occupancy grids."""
import json
import sys
from collections import deque
from pathlib import Path


def load_map(path):
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    grid = data["grid"]
    if not isinstance(grid, list) or not grid or not all(isinstance(row, str) and row for row in grid):
        raise ValueError("grid 应为非空字符串列表")
    if any(len(row) != len(grid[0]) or set(row) - {".", "#"} for row in grid):
        raise ValueError("地图必须等宽，只包含 . 和 #")
    for name in ("start", "goal"):
        point = data[name]
        if not isinstance(point, list) or len(point) != 2 or any(type(v) is not int for v in point):
            raise ValueError(name + " 必须是 [行, 列] 整数坐标")
        r, c = point
        if not (0 <= r < len(grid) and 0 <= c < len(grid[0])) or grid[r][c] == "#":
            raise ValueError(name + " 越界或位于障碍格")
    return grid, tuple(data["start"]), tuple(data["goal"])


def shortest_path(grid, start, goal):
    queue = deque([start])
    parents = {start: None}
    while queue:
        current = queue.popleft()
        if current == goal:
            path = []
            while current is not None:
                path.append(current)
                current = parents[current]
            return path[::-1]
        for dr, dc in ((0, 1), (1, 0), (0, -1), (-1, 0)):
            nxt = current[0] + dr, current[1] + dc
            r, c = nxt
            if 0 <= r < len(grid) and 0 <= c < len(grid[0]) and grid[r][c] == "." and nxt not in parents:
                parents[nxt] = current
                queue.append(nxt)
    return None


def run(solver=shortest_path):
    try:
        grid, start, goal = load_map(sys.argv[1] if len(sys.argv) > 1 else "map.json")
        path = solver(grid, start, goal)
        print(json.dumps({"reachable": path is not None, "steps": len(path)-1 if path else None, "path": path}, ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, TypeError, NotImplementedError) as error:
        print("无法规划：", error, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(run())
