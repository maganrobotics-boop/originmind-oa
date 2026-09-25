# 第 3 关：让别人看懂你的修改历史

建议 45–60 分钟。前置：第 2 关能运行 Git 和 Python。本关只操作新的本地练习仓库，不需要注册 GitHub，也不要求公开个人资料。

## 1. 下载材料

[下载完整材料包](lesson.zip) · [自动示例](make_demo.py) · [README 模板](README.template.md) · [仓库检查](check_repo.py) · [提交单](submission.md)

材料目录与个人练习仓库应并列，检查脚本保留在材料目录中。不要把练习建在已有项目仓库里面。

## 2. 跟着示例观察

在材料目录运行：

```text
python make_demo.py
python check_repo.py demo-repo
git -C demo-repo log --oneline --graph --all
```

脚本只新建 demo-repo，已有同名目录就停止；使用虚构作者且只设置此示例仓库。示例包含 3 次内容提交和 1 次合并提交。检查应输出“仓库结构检查通过”。哈希由提交内容和时间决定，不需要与教材相同。自动生成的示例不能作为个人作业。

理解三个位置：工作区是你正在编辑的文件；暂存区是下一次提交选中的内容；提交记录是已经保存的快照。add 不等于 commit，commit 也不等于 push。

## 3. 自己完成三次修改与合并

在材料目录中新建独立的 my-repo（材料目录本身不能处于其他 Git 仓库中）：

```text
mkdir my-repo
cd my-repo
git init -b main
git config user.name "My Learning Name"
git config user.email "learner@example.invalid"
```

这里的示例作者仅用于本地练习，你可换成自己的学习昵称。正式团队仓库再按团队身份规范设置，不要修改全局配置。

用编辑器将上级目录的 README.template.md 另存为 my-repo/README.md，并完成“本周目标”。执行第一次提交：

```text
git status
git add README.md
git diff --cached
git commit -m "docs: add weekly goal"
```

补充“兴趣方向”和“学习记录”，再 add、查看 diff、commit，提交信息写 `docs: record first exercise`。每次必须有实际内容变化，不能用空提交凑数。

创建分支并完成“合并复盘”，至少约 100 字，解释工作区、暂存区和提交记录，并记下一个自己的疑问：

```text
git switch -c practice
```

编辑并保存 README 后：

```text
git add README.md
git commit -m "docs: explain branch workflow"
git switch main
git merge --no-ff practice -m "merge: practice notes"
git log --oneline --graph --all
git status --short
python ../check_repo.py .
```

`--no-ff` 在本题中保留一个明确的合并提交，便于观察。验收前保留 practice 分支。不要用 reset --hard 清除不明修改。

变化任务：再建 `improvement` 分支，把目标中的一个模糊词改成可验证指标，提交并合并。记录修改前后，解释为什么更便于验收。

## 4. 对照标准结果

| 项目 | 标准 |
| --- | --- |
| 当前分支 | main |
| 内容历史 | 至少 3 次有意义的内容提交；主练习共至少 4 次提交含合并 |
| 合并 | practice 已包含在 main 历史中，有合并提交 |
| 工作区 | git status --short 不输出未提交项 |
| README | 四节齐全、无“待填写”，能解释修改过程 |
| 自检 | check_repo.py 退出码为 0；仍需人工阅读内容 |

## 5. 提交证据

填写 submission.md，附 README、图形日志和干净工作区截图、一次差异记录、个人变化任务。无需上传整个 .git；为保证可追溯可保存完整提交哈希。自检结果建议写在仓库外的 evidence 文件夹，以免刚生成的证据又变成未提交文件。

## 常见问题与助教提示

- nothing to commit：检查是否修改并保存、是否 add 了正确文件。
- Author identity unknown：在本练习仓库设置上面的两项 user 配置。
- 合并冲突：先用 git status 定位文件，理解两边内容后在编辑器保留正确版本、去掉冲突标记，再 add 和 commit；不确定时把完整差异交给助教解释。
- 问助教：“我在这个目录运行了这些命令，状态如下。请说明改动目前在工作区、暂存区还是历史里。”

## 参考资料

[Git 官方：分支与合并](https://git-scm.com/book/en/v2/Git-Branching-Basic-Branching-and-Merging)。本课示例独立编写，命令和图形输出以你本机的实际结果为准。
