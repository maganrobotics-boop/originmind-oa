"""Create a new local demo repo; never touches an existing repo or contacts a remote."""
import subprocess
from pathlib import Path

root = Path("demo-repo")
if root.exists():
    raise SystemExit("demo-repo 已存在；请查看已有示例，或在另一个新目录运行。")
root.mkdir()

def git(*args):
    subprocess.run(["git", "-C", str(root), *args], check=True)

git("init", "-b", "main")
git("config", "user.name", "Course Example")
git("config", "user.email", "example@example.invalid")
git("config", "commit.gpgsign", "false")
readme = root / "README.md"
text = "# 示例学习仓库（虚构）\n\n## 本周目标\n完成 Git 基础。\n\n## 兴趣方向\n导航。\n\n## 学习记录\n运行 git status。\n\n## 合并复盘\n"
readme.write_text(text, encoding="utf-8")
git("add", "README.md")
git("commit", "-m", "docs: create learning plan")
text += "我先在工作区编辑文件，再用 add 选择本次提交的内容，最后用 commit 保存快照。修改文件不会自动进入历史。\n"
readme.write_text(text, encoding="utf-8")
git("add", "README.md")
git("commit", "-m", "docs: explain staging")
git("switch", "-c", "practice")
text += "我在 practice 分支补充记录，提交后切回 main，使用 merge --no-ff 合并。合并提交连接两条历史；分支名是指向提交的标签，不是复制文件夹。用图形日志可以核对两条线如何汇合。示例由程序生成，不属于我的个人作业证据。\n"
readme.write_text(text, encoding="utf-8")
git("add", "README.md")
git("commit", "-m", "docs: record branch exercise")
git("switch", "main")
git("merge", "--no-ff", "practice", "-m", "merge: practice into main")
git("log", "--oneline", "--graph", "--all")
print("示例已生成。提交哈希会变化；请另建自己的练习仓库。")
