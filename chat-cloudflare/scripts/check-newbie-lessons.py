"""Exercise the shipped bundles in isolated directories; no ROS2 installation.

This checks the deterministic/offline portion. A real Ubuntu/Jazzy turtlesim run
remains a separate acceptance gate; analytic CSVs are never called ROS evidence.
"""
import ast
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote

PUBLIC = Path(__file__).resolve().parents[1] / "public"
ROOT = PUBLIC / "assets/newbie-course-v1"
ENV = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}


def run(args, cwd, ok=True):
    result = subprocess.run(args, cwd=cwd, env=ENV, text=True, capture_output=True, timeout=30)
    if (result.returncode == 0) != ok:
        raise AssertionError(f"{args}: unexpected exit {result.returncode}\n{result.stdout}\n{result.stderr}")
    return result.stdout + result.stderr


def module(path):
    spec = importlib.util.spec_from_file_location(path.parent.name+path.stem, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.ids = [], set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        if tag == "a" and "href" in attrs:
            self.links.append(attrs["href"])


class CurriculumChecks(unittest.TestCase):
    def test_01_generated_pages_links_and_bundles(self):
        for page in ROOT.rglob("index.html"):
            parsed = Links()
            parsed.feed(page.read_text())
            for href in parsed.links:
                url = urlsplit(href)
                if url.scheme or href.startswith("/"):
                    continue
                target = (page.parent / unquote(url.path)).resolve() if url.path else page
                self.assertTrue(target.is_file(), (page, href))
                if url.fragment and not url.path:
                    self.assertIn(url.fragment, parsed.ids)
        for archive in ROOT.rglob("lesson.zip"):
            with zipfile.ZipFile(archive) as bundle:
                self.assertIn("index.html", bundle.namelist())
                self.assertIn("README.md", bundle.namelist())
                self.assertIn("submission.md", bundle.namelist())
                for name in bundle.namelist():
                    self.assertNotIn("__pycache__", name)
                    self.assertEqual(bundle.read(name), (archive.parent/name).read_bytes(), name)
        for source in ROOT.rglob("*.py"):
            ast.parse(source.read_text(), filename=str(source))

    def test_02_registration_budget_and_placeholders(self):
        folder = ROOT/"registration"
        check = module(folder/"check_profile.py").validate
        sample = json.loads((folder/"profile.example.json").read_text())
        self.assertEqual(check(sample), [])
        self.assertTrue(check(json.loads((folder/"profile.template.json").read_text())))
        sample["weekly_hours"] = 3
        self.assertTrue(any("超过" in x for x in check(sample)))
        sample["weekly_hours"] = float("nan")
        self.assertTrue(check(sample))

    def test_03_toolkit_and_actual_hello_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run([sys.executable, str(ROOT/"toolkit/check_environment.py"), "."], root, ok=False)
            for name in ("code", "data", "evidence", "notes"):
                (root/name).mkdir()
            source = (ROOT/"toolkit/hello.py").read_text()
            (root/"code/hello.py").write_text(source)
            self.assertIn("你好，学习者！本周计划学习 4 小时。", run([sys.executable, "code/hello.py"], root))
            (root/"code/hello.py").write_text(source.replace('"学习者"', '"测试同学"').replace('HOURS = 4', 'HOURS = 2.5'))
            self.assertIn("你好，测试同学！本周计划学习 2.5 小时。", run([sys.executable, "code/hello.py"], root))
            result = json.loads(run([sys.executable, str(ROOT/"toolkit/check_environment.py"), "."], root))
            self.assertEqual(result["status"], "PASS")

    def test_04_git_demo_valid_history_and_dirty_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run([sys.executable, str(ROOT/"git-basics/make_demo.py")], root)
            run([sys.executable, str(ROOT/"git-basics/check_repo.py"), "demo-repo"], root)
            self.assertEqual(run(["git", "rev-list", "--count", "HEAD"], root/"demo-repo").strip(), "4")
            (root/"demo-repo/extra.txt").write_text("not yet committed")
            run([sys.executable, str(ROOT/"git-basics/check_repo.py"), "demo-repo"], root, ok=False)
            run([sys.executable, str(ROOT/"git-basics/make_demo.py")], root, ok=False)

    def test_05_ros_analytic_reference_and_radius_change_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("motion.py", "simulate.py", "check_pose.py"):
                shutil.copy2(ROOT/"ros2-simulation"/name, root/name)
            run([sys.executable, "simulate.py", "original.csv"], root)
            run([sys.executable, "check_pose.py", "original.csv"], root)
            motion = root/"motion.py"
            motion.write_text(motion.read_text().replace("LINEAR = 1.0", "LINEAR = 0.5"))
            run([sys.executable, "simulate.py", "half.csv"], root)
            run([sys.executable, "check_pose.py", "half.csv", "--radius", "0.5"], root)
            run([sys.executable, "check_pose.py", "half.csv"], root, ok=False)
            run([sys.executable, "simulate.py", "half.csv"], root, ok=False)
            motion.write_text(motion.read_text().replace("ANGULAR = 1.0", "ANGULAR = -1.0"))
            run([sys.executable, "simulate.py", "reverse.csv"], root)
            run([sys.executable, "check_pose.py", "reverse.csv", "--radius", "0.5"], root)

    def test_06_planner_reference_and_unfinished_exercise(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with zipfile.ZipFile(ROOT/"mini-project/lesson.zip") as bundle:
                bundle.extractall(root)
            self.assertEqual(json.loads(run([sys.executable, "planner.py", "map.json"], root))["steps"], 10)
            self.assertEqual(json.loads(run([sys.executable, "planner.py", "blocked.json"], root))["reachable"], False)
            self.assertIn("Ran 6 tests", run([sys.executable, "check_work.py", "--reference"], root))
            run([sys.executable, "check_work.py"], root, ok=False)
            shutil.copy2(root/"planner.py", root/"exercise.py")
            self.assertIn("Ran 6 tests", run([sys.executable, "check_work.py"], root))
            (root/"invalid.json").write_text('{"grid":["#"],"start":[0,0],"goal":[0,0]}')
            run([sys.executable, "planner.py", "invalid.json"], root, ok=False)

    def test_07_evidence_archive_can_be_rechecked_and_rejects_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with zipfile.ZipFile(ROOT/"graduation/lesson.zip") as bundle:
                bundle.extractall(root)
            self.assertIn("DEMO_ONLY", run([sys.executable, "audit_evidence.py", "sample/manifest.json", "--pack", "demo.zip"], root))
            with zipfile.ZipFile(root/"demo.zip") as bundle:
                bundle.extractall(root/"unpacked")
            run([sys.executable, "audit_evidence.py", "unpacked/manifest.json"], root)
            (root/"sample/toolkit.md").unlink()
            run([sys.executable, "audit_evidence.py", "sample/manifest.json"], root, ok=False)
            run([sys.executable, "audit_evidence.py", "manifest.template.json"], root, ok=False)
            manifest = root/"sample/manifest.json"
            data = json.loads(manifest.read_text())
            data["stages"][0]["files"] = ["../audit_evidence.py"]
            manifest.write_text(json.dumps(data))
            self.assertIn("相对路径", run([sys.executable, "audit_evidence.py", "sample/manifest.json"], root, ok=False))


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    unittest.main(verbosity=2)
