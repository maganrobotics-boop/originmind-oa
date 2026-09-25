# 第 2 关：让一段程序在自己的电脑上运行

建议 40–60 分钟，首次安装可另留时间。目标是使用编辑器、终端、Python 和 Git，记录能让别人复现的环境信息。手机可看教程，实际运行需电脑。

## 1. 下载与准备

[下载完整材料包](lesson.zip) · [示例程序 hello.py](hello.py) · [环境检查程序](check_environment.py) · [提交单](submission.md)

安装 [Python](https://www.python.org/downloads/)、[Git](https://git-scm.com/install/) 和 [VS Code](https://code.visualstudio.com/download)。本套练习采用 Python 3.10 或以上，除 ROS2 关外只用标准库。Windows 安装后重新打开终端，让 PATH 更新生效。

Windows 可用 PowerShell；macOS/Linux 可用系统终端。先运行：

```text
python --version
git --version
```

macOS/Linux 常用 `python3`；Windows 若 `python` 不存在，试 `py -3 --version`。确定一种可用方式后，下文所有 python 命令统一替换，不要混用多个解释器。

ROS2 关采用 Ubuntu 24.04 + ROS2 Jazzy。当前关无需先装 ROS2。Windows 到第 5 关前可按 [微软 WSL 安装说明](https://learn.microsoft.com/en-us/windows/wsl/install) 准备 Ubuntu；先用 `wsl --list --online` 查看可用发行版，再选择 Ubuntu 24.04。安装及重启在个人电脑上完成，不在 OA 服务器上做练习。macOS 可用已有的 Ubuntu 虚拟机或实验室电脑。

## 2. 跟着示例运行

解压到一个新的学习目录。用 VS Code 的“打开文件夹”打开它，再选择“终端 → 新建终端”。运行：

```text
python hello.py
```

标准输出为 `你好，学习者！本周计划学习 4 小时。` 命令里没有 `>>>`；看到 `>>>` 表示你进入了 Python 交互模式，先输入 `exit()` 返回系统终端。

建立四个目录（也可以在文件管理器中新建）：

```text
python -c "from pathlib import Path; [Path(p).mkdir(exist_ok=True) for p in ('code','data','evidence','notes')]"
```

用编辑器把 hello.py 另存为 code/hello.py。code 放代码，data 放原始数据，evidence 放输出与截图，notes 放说明。保留材料包原文件作对照。

## 3. 修改代码并解释

把 code/hello.py 的 `NAME` 改成自己的昵称，把 `HOURS` 改成第 1 关实际计划的时间。先在 notes 中写下预计出现的整行文字，再运行：

```text
python code/hello.py
python check_environment.py .
```

第二条应输出 JSON，包含实际 Python/Git 版本、四个目录均为 true、hello_exists 为 true、errors 为空列表、status 为 PASS。版本号因电脑而异，不要求和别人的截图一致。程序不会安装软件，也不会检查你是否真正理解了代码。

变化任务：把 HOURS 从整数 4 改成小数 2.5，预测输出。再故意把一对引号删掉，运行并记录 SyntaxError 的行号，随后修复。不要提交仍然报错的最终版本。

## 4. 对照验收标准

| 检查 | 通过标准 |
| --- | --- |
| 基础环境 | 同一终端能运行 Python 和 Git 的版本命令 |
| 文件组织 | 四目录存在，code/hello.py 能从学习目录运行 |
| 修改结果 | 输出与你事先写下的昵称、小时数一致 |
| 排错 | 能指出一次报错的文件、行号、原因和修复 |
| 环境记录 | 写清操作系统、解释器调用方式和版本 |

截图只截必要的输出区域，避免把私人目录、令牌或无关桌面内容放入证据。

## 5. 提交证据

填写 submission.md，附修改后的 code/hello.py、初始与修改输出、环境检查结果、一次错误及修复说明。保存环境报告可用：

```text
python check_environment.py . > evidence/environment.json
```

重定向后屏幕不显示结果是正常的，用编辑器打开该文件。返回第 2 关填入证据摘要或链接。

## 常见问题与助教提示

- “找不到文件”：核对终端当前目录和 code/hello.py 是否真的保存；不要把 .py 保存成 .py.txt。
- Git 装了仍找不到：关闭旧终端并重新打开；检查安装位置是否进入 PATH。
- 中文乱码：文件保存为 UTF-8，先保留原始输出，不要用乱码截图冒充正确结果。
- 问助教：“这是命令、完整报错、文件路径和预期输出。请先帮我判断是目录问题、语法问题还是环境问题。”

## 我能解释

编辑器与终端分别负责什么？为什么修改文件但不保存，运行结果可能不变？环境检查 PASS 能否证明所有后续课程已经完成？
