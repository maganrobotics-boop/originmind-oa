# 第 5 关：发布运动命令，记录实际反馈

建议 60–90 分钟，ROS2 安装时间另计。前置：Python 日志关。目标是在 turtlesim 中完成一整圈，理解节点、话题和消息，修改圆的半径，并用记录的 pose 判断是否达到预期。

## 1. 下载材料与核对环境

[下载完整材料包](lesson.zip) · [运动参数 motion.py](motion.py) · [ROS2 发布与记录程序](run_ros.py) · [离线理论轨迹](simulate.py) · [轨迹检查](check_pose.py) · [提交单](submission.md)

本课环境基线为 Ubuntu 24.04 + ROS2 Jazzy，使用系统 python3 和 turtlesim。先按 [ROS2 官方安装说明](https://docs.ros.org/en/jazzy/Installation/Ubuntu-Install-Debians.html) 完成软件源与 Jazzy 安装；不要把不同 Ubuntu/ROS2 版本的安装命令混用。ROS2 官方 [发布说明](https://github.com/ros2/ros2/releases) 也列出了 Jazzy 对应平台。

已完成官方软件源配置后，如缺少 turtlesim，可在 Ubuntu 终端运行 `sudo apt install ros-jazzy-turtlesim`。每个新终端都先执行：

```bash
source /opt/ros/jazzy/setup.bash
export ROS_DOMAIN_ID=42
ros2 --help
```

本题只操作独立命名空间 `/newbie_lab` 下的海龟仿真。关闭其他同名练习，避免多个发布者同时控制一只海龟；不把话题改为真实机器人的 cmd_vel。

Windows 使用支持图形界面的 WSL2/Ubuntu 或实验室 Ubuntu 电脑；macOS 可用 Ubuntu 虚拟机。若 GUI 尚未就绪，可先完成离线部分，但本关状态应保留“进行中”。

## 2. 跟着示例运行

先在材料目录跑纯 Python 预检，不需要 ROS2：

```text
python3 simulate.py synthetic_pose.csv
python3 check_pose.py synthetic_pose.csv
```

标准理论值：半径 1 仿真单位，角速度 1 rad/s，一圈约 6.283 s，路程约 6.283，起终点偏差约 0。simulate.py 明确标注 SYNTHETIC_ONLY；它是公式生成的数据，不是 ROS2 运行日志。

现在执行真实仿真。终端 A 完成环境 source 后启动：

```bash
ros2 run turtlesim turtlesim_node --ros-args -r __ns:=/newbie_lab
```

终端 B 同样 source、设置同一 ROS_DOMAIN_ID，检查可见的系统：

```bash
ros2 node list --no-daemon --spin-time 3
ros2 topic list -t --no-daemon --spin-time 3
ros2 topic info /newbie_lab/turtle1/cmd_vel
ros2 interface show geometry_msgs/msg/Twist
ros2 topic echo /newbie_lab/turtle1/pose --once
```

首次发现需要时间；上面两条命令等待 3 秒再输出，避免把短暂的空列表当成启动失败。

应看到 `/newbie_lab/turtlesim` 节点；cmd_vel 类型是 `geometry_msgs/msg/Twist`，pose 类型是 `turtlesim/msg/Pose`。Twist 中 linear.x 控制前进，angular.z 控制转动；pose 是反馈，不能把“发出了命令”当成“已经到达”。

终端 C 进入材料目录，同样 source 和设置 domain，再运行：

```bash
python3 run_ros.py --output ros_pose.csv
python3 check_pose.py ros_pose.csv
```

程序等待海龟 pose 与命令订阅者就绪，再持续发布约一圈的速度命令，同时订阅并保存 pose，最后发布零速度并结束。超过 10 秒没有就绪就报错，不会假装生成成功结果。输出文件若存在，改用新文件名；旧证据不会被覆盖。

## 3. 修改代码，先预测再运行

在 motion.py 中把 `LINEAR = 1.0` 改为 `LINEAR = 0.5`，保留 `ANGULAR = 1.0` 和一圈时长。先写预测：半径等于 |v/ω|，因此半径变为 0.5，周期不变，路程约 3.142。

先运行离线检查：

```bash
python3 simulate.py synthetic_half.csv
python3 check_pose.py synthetic_half.csv --radius 0.5
```

关闭并重新启动终端 A 的 turtlesim，让海龟回到初始状态；保持同一命名空间和 domain。再运行：

```bash
python3 run_ros.py --output ros_half.csv
python3 check_pose.py ros_half.csv --radius 0.5
```

读代码练习：在 run_ros.py 中找到 create_publisher、create_subscription、定时回调和零速度发送各在哪里，用自己的话注释这四处。补充一个自主变化实验：把 ANGULAR 改成 -1，预测旋转方向变化，重新启动海龟再验证；保持本课参数范围。

## 4. 对照标准结果

| 指标 | 原始圆 | 半速圆 |
| --- | --- | --- |
| 理论半径 | 1 | 0.5 |
| 一圈理论时长 | 2π，约 6.283 s | 同左 |
| 理论路程 | 2π，约 6.283 | π，约 3.142 |
| 实录时长容差 | 6.0–7.2 s，含停止缓冲 | 同左 |
| 实录路程容差 | 与理论值差不超过 0.5 | 同左 |
| 闭合误差 | 不超过 0.35 | 同左 |
| 外接框宽/高 | 与直径 2 的差各不超过 0.35 | 与直径 1 的差各不超过 0.35 |

这些坐标是 turtlesim 仿真单位，不是经过标定的真实米制结果。采样和调度会产生偏差，不要求每行数据完全相同。检查程序只判断几何指标，无法证明日志来源，必须同时提交真实 ROS2 运行证据。

## 5. 提交证据

提交修改前后的 motion.py、两份真实 CSV、节点/话题输出、海龟轨迹截图或短视频、两次检查结果、理论值与实际值对照、四处代码解释和自主实验。填写 submission.md。

未完成真实仿真时如实填写阻塞原因、已尝试命令和报错；离线数据不得更名为实录或标记整关完成。助教可以协助排错，最终运行需本人完成。

## 常见问题与助教提示

- ros2 不存在或 No module named rclpy：在 Ubuntu 系统终端重新 source，使用系统 python3，不在未配置 ROS 的 Python 虚拟环境里运行。
- 看不到海龟/Qt 无法连接显示：先确认 Ubuntu 图形终端可用，再排查 WSLg 或虚拟机桌面；这不是 Python 路程公式的问题。
- 10 秒等待超时：比较三个终端的 domain、命名空间，核对节点和话题输出。
- 圆形不闭合或撞墙：重启干净的海龟，关闭其他速度发布者，先恢复原参数再试，不要直接放宽验收阈值。
- 问助教：“这是真实 pose 的前后几行、节点/话题列表、参数和检查结果。请判断是通信、初始状态还是几何计算问题。”

## 参考资料

[ROS2 官方 turtlesim 教程](https://docs.ros.org/en/jazzy/Tutorials/Beginner-CLI-Tools/Introducing-Turtlesim/Introducing-Turtlesim.html) · [ROS2 官方 Python 发布/订阅](https://docs.ros.org/en/jazzy/Tutorials/Beginner-Client-Libraries/Writing-A-Simple-Py-Publisher-And-Subscriber.html)。本课代码独立编写；运行结果以你自己的实验日志为准。
