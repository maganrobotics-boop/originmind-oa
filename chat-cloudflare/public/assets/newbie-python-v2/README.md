# Python 日志分析实训 V1

本包所有 CSV 均为教学模拟数据，不是真实机器人实验记录。
无需账号、ROS2、真机或第三方库。建议 60–90 分钟；需要 Python 3 和基本循环、列表、字典知识。
双击 index.html 可离线阅读完整教程；其中返回新手村和助教的链接仅在线站点有效。

## 开始

完整解压 ZIP，在含 analyze.py 的目录打开终端。
macOS/Linux 如使用 python3，将以下所有 python 替换为 python3。
Windows 如只有 py 命令，可替换为 py -3。

```sh
python --version
python analyze.py data/motion_log.csv
python check_work.py --reference
```

标准结果：21 点、20 s、10 m、平均速率 0.5 m/s、最大分段速率 0.5 m/s、
位移 0 m、电量下降 5 个百分点、可疑区间 0 个。参考自检应为 8 项通过。

## 字段与算法

- time：相对时间，秒，严格递增。
- x、y：同一坐标系内的位置，米。
- yaw：朝向，弧度；本关不参与路程计算。
- battery：0–100 的电量百分数；90 表示 90%。
- 每段路程是相邻位置的欧氏距离；总路程是各段之和。
- 平均速率是总路程除以总时长；时间间隔不等时不能平均各段速率。
- 起终点位移与累计路程不同。正方形闭环的位移为 0，路程为 10 m。
- 电量从 90% 到 85% 是下降 5 个百分点；没有设备和负载基线时不能诊断电池异常。
- 可疑区间指分段速率严格大于阈值的区间。默认 1.5 m/s 仅是教学阈值。

## 我的练习

编辑 exercise.py 的三个 TODO。公共代码提供读入校验和输出，你实现 summarize。
字典键名保持模板约定，数值不要提前四舍五入。

```sh
python exercise.py data/motion_log.csv
python check_work.py
python exercise.py data/position_jump.csv
```

未完成的模板会给出明确提示，自检也会失败，这是预期行为。
不要把加了 --reference 的自检当作个人作业结果。
异常日志：总路程 11 m、时长 3 s、平均约 3.667 m/s、最大 10 m/s、
1–2 s 为唯一可疑区间、电量下降 0.75 个百分点。
位置跳变、时间单位错误等都可能造成高估，不能直接断定实际运动速度。

再自行构造并验证一份数据：静止、3-4-5 斜线或非等间隔采样任选其一。
保留五列，并在运行前写下手算预期。

## 排查

- 找不到文件：完整解压，进入正确目录，不要只下载一个 .py 文件。
- 找不到 Python：确认 Python 3 安装和终端命令。
- 缺列/空值/重复时间：检查英文逗号、表头和报错行。
- 路程为 0：检查是否只算了起终点距离。
- 非等间隔用例失败：平均速率必须是总路程 / 总时长。

## 验收

1. 标准数据的七项指标误差不超过 0.001，正确定位异常区间。
2. 自己的 exercise.py 通过八项自检，提供环境、命令和输出。
3. 提交自建数据、手算值、运行结果和对照说明。
4. 完成 submission.md 的解释与复盘，注明参考代码及助教帮助。

本机标记和自检不等于教师审核通过，也不自动授予任何内部权限。

## 文件

index.html 完整教程；analyze.py 参考实现；exercise.py 个人模板；
check_work.py 自检；expected.json 标准数值；submission.md 提交单；data/ 两份模拟日志。

## 官方参考

- https://docs.python.org/3/library/csv.html
- https://docs.python.org/3/library/math.html#math.hypot
- https://docs.python.org/3/library/unittest.html
