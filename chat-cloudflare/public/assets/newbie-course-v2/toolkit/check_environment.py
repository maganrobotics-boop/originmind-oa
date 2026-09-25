"""Check the current Python/Git and exercise directories; never install anything."""
import json
import platform
import subprocess
import sys
from pathlib import Path


def inspect(root):
    result = {"python": platform.python_version(), "os": platform.system()}
    errors = []
    if sys.version_info < (3, 10):
        errors.append("本课程建议 Python 3.10 或以上")
    try:
        completed = subprocess.run(["git", "--version"], text=True, capture_output=True, timeout=5, check=True)
        result["git"] = completed.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        errors.append("当前终端无法运行 git --version")
    result["folders"] = {name: (root / name).is_dir() for name in ("code", "data", "evidence", "notes")}
    errors.extend("缺少目录：" + name for name, present in result["folders"].items() if not present)
    result["hello_exists"] = (root / "code" / "hello.py").is_file()
    if not result["hello_exists"]:
        errors.append("缺少 code/hello.py")
    result["errors"] = errors
    result["status"] = "PASS" if not errors else "NEEDS_WORK"
    return result


if __name__ == "__main__":
    result = inspect(Path(sys.argv[1] if len(sys.argv) > 1 else "."))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(result["status"] != "PASS")
