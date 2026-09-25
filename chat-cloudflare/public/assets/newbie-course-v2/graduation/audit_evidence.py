"""Check a local manifest and package only its explicitly listed relative files."""
import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

STAGES = {"registration", "toolkit", "git-basics", "python-basics", "ros2-simulation", "mini-project"}


def audit(manifest_path):
    root = manifest_path.resolve().parent
    data = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    errors, files = [], {}
    def filled(text):
        return isinstance(text, str) and bool(text.strip()) and "待填写" not in text
    if not isinstance(data, dict):
        return {}, ["manifest 必须是对象"], {}
    for key in ("learner", "reflection", "next_goal", "ai_help"):
        if not filled(data.get(key)):
            errors.append(key + " 未填写")
    if type(data.get("is_demo")) is not bool:
        errors.append("is_demo 必须是 true 或 false")
    stages = data.get("stages", [])
    if not isinstance(stages, list) or not all(isinstance(s, dict) for s in stages):
        return data, errors + ["stages 应为对象列表"], files
    ids = [s.get("id") for s in stages]
    if len(ids) != 6 or set(ids) != STAGES:
        errors.append("必须逐项列出前六关且不重复")
    for stage in stages:
        name = str(stage.get("id"))
        if stage.get("status") != "completed":
            errors.append(name + " 尚未完成；不能用模板或离线预检代替真实实验")
        for key in ("command", "expected", "actual", "change", "explanation"):
            if not filled(stage.get(key)):
                errors.append(name + ": " + key + " 未填写")
        paths = stage.get("files")
        if not isinstance(paths, list) or not paths:
            errors.append(name + " 缺少证据文件")
            continue
        for value in paths:
            if not isinstance(value, str) or not value:
                errors.append(name + " 文件路径无效")
                continue
            path = root / value
            if Path(value).is_absolute() or ".." in Path(value).parts or "\\" in value or not path.resolve().is_relative_to(root):
                errors.append(name + " 只接受证据目录内的相对路径")
            elif not path.is_file() or path.stat().st_size == 0:
                errors.append(name + " 文件缺失或为空：" + value)
            elif path.stat().st_size > 25*1024*1024:
                errors.append(name + " 单文件超过 25 MB，请用已授权的演示链接写入说明文件")
            else:
                files[value] = hashlib.sha256(path.read_bytes()).hexdigest()
    return data, errors, files


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("--pack", metavar="OUTPUT_ZIP")
    args = parser.parse_args()
    try:
        manifest = Path(args.manifest)
        data, errors, files = audit(manifest)
        if errors:
            print("\n".join(errors))
            raise SystemExit(1)
        label = "DEMO_ONLY 示例结构通过，不可作为个人作业" if data["is_demo"] else "证据结构检查通过，等待内容验收"
        print(label)
        print("关卡：6；证据文件：", len(files))
        if args.pack:
            output = Path(args.pack).resolve()
            if output == manifest.resolve() or any(output == (manifest.resolve().parent / p).resolve() for p in files):
                raise ValueError("输出文件不能覆盖输入证据")
            with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as bundle:
                packed = json.loads(json.dumps(data))
                for stage in packed["stages"]:
                    stage["files"] = ["evidence/"+p for p in stage["files"]]
                bundle.writestr("manifest.json", json.dumps(packed, ensure_ascii=False, indent=2))
                bundle.writestr("SHA256SUMS.txt", "\n".join(h+"  evidence/"+p for p, h in files.items()))
                for path in files:
                    bundle.write(manifest.resolve().parent/path, "evidence/"+path)
            print("已生成：", output.name)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("无法整理：", error)
        sys.exit(2)
