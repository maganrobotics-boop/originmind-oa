"""Build standalone, offline-readable course pages and deterministic ZIP bundles.

Usage: python3 chat-cloudflare/scripts/build-newbie-lessons.py
Only the small Markdown subset used in these owned lesson files is supported.
No external packages, services or student data are used.
"""
import html
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "public/assets/newbie-course-v2"
LESSONS = ("registration", "toolkit", "git-basics", "ros2-simulation", "mini-project", "graduation")
STYLE = """
*{box-sizing:border-box}body{margin:0;color:#20242b;background:#fff;font:16px/1.8 system-ui,-apple-system,Segoe UI,sans-serif}
header,main,footer{max-width:960px;margin:auto;padding:24px}header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;border-bottom:1px solid #e5e8ee}
a{color:#245ed1;text-underline-offset:3px}a:focus-visible{outline:3px solid #245ed1;outline-offset:4px}h1{font-size:30px;line-height:1.4;margin:18px 0 24px}h2{font-size:23px;line-height:1.5;margin:42px 0 16px;padding-top:20px;border-top:1px solid #e5e8ee;scroll-margin-top:16px}h3{font-size:18px}p{margin:14px 0}li{margin:8px 0}
pre{background:#f4f6f9;border-radius:8px;padding:18px;overflow:auto;font-size:14px;line-height:1.6}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}pre code{overflow-wrap:normal}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left;font-size:15px}th,td{border-bottom:1px solid #e0e5ee;padding:10px 12px;vertical-align:top}th{background:#f4f6f9}nav{display:flex;flex-wrap:wrap;gap:10px 16px;margin:18px 0;font-size:14px}.note{padding:14px 18px;background:#f0f6ff;border-left:3px solid #3774df}.actions{display:flex;gap:12px;flex-wrap:wrap;margin:28px 0}.button{display:inline-block;padding:10px 16px;background:#2866e7;color:white;border-radius:7px;text-decoration:none;font-weight:600}footer{color:#647083;font-size:14px;border-top:1px solid #e5e8ee}.cards{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{padding:20px;border:1px solid #dce3ee;border-radius:12px}.card h2{border:0;padding:0;margin:0 0 12px;font-size:21px}
@media(max-width:640px){header,main,footer{padding-left:18px;padding-right:18px}h1{font-size:25px}h2{font-size:21px}.cards{grid-template-columns:1fr}th,td{padding:8px}}
"""


def inline(text):
    parts = re.split(r"(`[^`]+`|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)", text)
    out = []
    for part in parts:
        if part.startswith("`") and part.endswith("`"):
            out.append("<code>"+html.escape(part[1:-1])+"</code>")
        elif re.fullmatch(r"\[([^\]]+)\]\(([^)]+)\)", part):
            match = re.fullmatch(r"\[([^\]]+)\]\(([^)]+)\)", part)
            label, href = match.groups()
            download = " download" if not href.startswith(("http:", "https:", "/", "#")) else ""
            out.append('<a href="'+html.escape(href, quote=True)+'"'+download+'>'+html.escape(label)+"</a>")
        elif part.startswith("**") and part.endswith("**"):
            out.append("<strong>"+html.escape(part[2:-2])+"</strong>")
        else:
            out.append(html.escape(part))
    return "".join(out)


def render(text):
    lines = text.splitlines()
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("```"):
            block = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                block.append(lines[i])
                i += 1
            out.append("<pre><code>"+html.escape("\n".join(block))+"</code></pre>")
        elif line.startswith("#"):
            level = len(line)-len(line.lstrip("#"))
            heading = line[level:].strip()
            match = re.match(r"([1-5])\.", heading)
            anchor = f' id="step-{match.group(1)}"' if level == 2 and match else ""
            out.append(f"<h{level}{anchor}>"+inline(heading)+f"</h{level}>")
        elif line.startswith("| "):
            table = []
            while i < len(lines) and lines[i].startswith("|"):
                row = [x.strip() for x in lines[i].strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", cell.replace(" ", "")) for cell in row):
                    table.append(row)
                i += 1
            head = "<tr>"+"".join("<th>"+inline(x)+"</th>" for x in table[0])+"</tr>"
            body = "".join("<tr>"+"".join("<td>"+inline(x)+"</td>" for x in row)+"</tr>" for row in table[1:])
            out.append('<div class="table-wrap"><table><thead>'+head+"</thead><tbody>"+body+"</tbody></table></div>")
            continue
        elif line.startswith("- "):
            items = []
            while i < len(lines) and lines[i].startswith("- "):
                items.append("<li>"+inline(lines[i][2:])+"</li>")
                i += 1
            out.append("<ul>"+"".join(items)+"</ul>")
            continue
        else:
            out.append("<p>"+inline(line)+"</p>")
        i += 1
    return "\n".join(out)


def page(title, body):
    return ('<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>'+html.escape(title)+' · 新手村</title><style>'+STYLE+'</style></head><body>'
            '<header><a href="/newbie-village">新手村 · 任务地图</a><span>OriginMind × ARTS Robotics</span></header>'
            '<main>'+body+'</main><footer>公开学习无需登录。解压后可离线阅读；返回系统和外部参考链接需联网。正式提交与项目权限按系统实际流程办理。</footer></body></html>\n')


def build():
    cards = []
    for slug in LESSONS:
        folder = ROOT / slug
        markdown = (folder / "README.md").read_text()
        title = markdown.splitlines()[0].lstrip("# ")
        nav = '<nav aria-label="学习步骤">'+"".join(f'<a href="#step-{i}">{label}</a>' for i, label in enumerate(("下载材料", "运行示例", "独立修改", "对照标准", "提交证据"), 1))+"</nav>"
        body = nav+render(markdown)+f'<div class="actions"><a class="button" href="lesson.zip" download>下载本关全部材料</a><a href="/newbie-village#{slug}">返回本关记录成果</a><a href="/?ta=1&amp;course={slug}">问本关助教</a><a href="../index.html">全部七关</a></div>'
        (folder / "index.html").write_text(page(title, body))
        entries = [p for p in sorted(folder.rglob("*")) if p.is_file() and p.suffix not in (".zip", ".pyc") and "__pycache__" not in p.parts]
        with zipfile.ZipFile(folder/"lesson.zip", "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for path in entries:
                info = zipfile.ZipInfo(str(path.relative_to(folder)), date_time=(2026, 9, 25, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                bundle.writestr(info, path.read_bytes())
        cards.append((int(title[2]), f'<article class="card"><h2>{html.escape(title)}</h2><a href="{slug}/index.html">打开完整教程</a> · <a href="{slug}/lesson.zip" download>下载材料包</a></article>'))
    cards.append((4, '<article class="card"><h2>第 4 关：Python 日志分析</h2><a href="../newbie-python-v2/index.html">打开完整教程</a> · <a href="../newbie-python-v2/python-log-lab.zip" download>下载材料包</a></article>'))
    body = '<h1>七关，从第一条命令到可复现成果</h1><p>每一关都按同一条路径学习：下载材料 → 跟着示例运行 → 自己修改 → 对照标准 → 提交证据。</p><p class="note">可直接阅读和下载，无需账号。示例、自检、本机进度和教师验收分别记录；第 5 关必须补齐真实 ROS2 实验。</p><div class="cards">'+"".join(card for _, card in sorted(cards))+"</div>"
    (ROOT/"index.html").write_text(page("完整课程与材料", body))
    print("Built 6 lessons, 6 ZIP bundles and the seven-course index")


if __name__ == "__main__":
    build()
