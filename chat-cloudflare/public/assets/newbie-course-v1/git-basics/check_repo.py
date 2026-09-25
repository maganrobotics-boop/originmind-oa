"""Inspect only the explicitly selected practice repository."""
import argparse
import subprocess
import sys
from pathlib import Path


def validate(root):
    errors = []
    def git(*args):
        return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True, timeout=10).stdout.strip()
    try:
        actual = Path(git("rev-parse", "--show-toplevel")).resolve()
        if actual != root.resolve():
            return ["指定目录不是独立仓库根目录；不要在上级项目仓库中练习"]
        if git("branch", "--show-current") != "main":
            errors.append("请切回 main")
        if int(git("rev-list", "--count", "HEAD")) < 3:
            errors.append("至少需要三次提交")
        if not git("log", "--merges", "--format=%H"):
            errors.append("缺少合并提交；本练习用 merge --no-ff 保留合并证据")
        try:
            git("merge-base", "--is-ancestor", "practice", "main")
        except subprocess.CalledProcessError:
            errors.append("practice 不存在或尚未合并入 main；验收前保留该分支")
        if git("status", "--porcelain"):
            errors.append("仍有未提交文件，请核对后提交")
        git("ls-files", "--error-unmatch", "README.md")
        readme = (root / "README.md").read_text(encoding="utf-8-sig")
        for heading in ("本周目标", "兴趣方向", "学习记录", "合并复盘"):
            if heading not in readme:
                errors.append("README 缺少：" + heading)
        if "待填写" in readme or len(readme) < 180:
            errors.append("请完成 README 和至少约 100 字的合并复盘")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        errors.append("无法完成检查；确认 Git 可用且目录含已提交的 README：" + str(error))
    return errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("repository", help="练习仓库的目录路径")
    args = parser.parse_args()
    errors = validate(Path(args.repository))
    print("\n".join(errors) if errors else "仓库结构检查通过；内容质量和个人理解需另行验收。")
    sys.exit(bool(errors))
