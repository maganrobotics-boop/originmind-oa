import importlib
import sys
import unittest

reference = "--reference" in sys.argv
solver = importlib.import_module("planner" if reference else "exercise").shortest_path


class PlannerChecks(unittest.TestCase):
    def route(self, grid, start, goal, steps):
        path = solver(grid, start, goal)
        self.assertIsInstance(path, list)
        self.assertEqual(tuple(path[0]), start)
        self.assertEqual(tuple(path[-1]), goal)
        self.assertEqual(len(path)-1, steps)
        for point in path:
            r, c = point
            self.assertTrue(0 <= r < len(grid) and 0 <= c < len(grid[0]))
            self.assertEqual(grid[r][c], ".")
        for a, b in zip(path, path[1:]):
            self.assertEqual(abs(a[0]-b[0])+abs(a[1]-b[1]), 1)

    def test_01_course_map(self):
        self.route([".......", ".###.#.", "...#.#.", ".#...#.", "......."], (0, 0), (4, 6), 10)

    def test_02_detour(self):
        self.route(["...", ".#.", "..."], (1, 0), (1, 2), 4)

    def test_03_unreachable(self):
        self.assertIsNone(solver(["..#.."]*3, (1, 0), (1, 4)))

    def test_04_same_point(self):
        self.route(["."], (0, 0), (0, 0), 0)

    def test_05_no_diagonals(self):
        self.assertIsNone(solver([".#", "#."], (0, 0), (1, 1)))

    def test_06_corridor(self):
        self.route(["....."], (0, 4), (0, 0), 4)


if __name__ == "__main__":
    print("检查对象：" + ("参考实现" if reference else "自己的 exercise.py"))
    unittest.main(argv=[sys.argv[0]], verbosity=2)
