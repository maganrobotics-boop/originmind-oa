"""Bounded publisher + pose subscriber, exclusively on /newbie_lab/turtle1/*."""
import argparse
import csv
import math
import time
from pathlib import Path
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from turtlesim.msg import Pose
from motion import command, LINEAR, ANGULAR, DURATION


class CircleRecorder(Node):
    def __init__(self, handle):
        super().__init__("newbie_circle_recorder", namespace="/newbie_lab")
        self.pub = self.create_publisher(Twist, "/newbie_lab/turtle1/cmd_vel", 10)
        self.sub = self.create_subscription(Pose, "/newbie_lab/turtle1/pose", self.pose, 10)
        self.writer = csv.writer(handle)
        self.writer.writerow(["time", "x", "y", "theta"])
        self.started = None
        self.waiting_since = time.monotonic()
        self.done = False
        self.failed = False
        self.timer = self.create_timer(0.05, self.tick)

    def pose(self, msg):
        now = time.monotonic()
        if self.started is None:
            if self.pub.get_subscription_count() < 1:
                return
            self.started = now
        self.writer.writerow([now-self.started, msg.x, msg.y, msg.theta])

    def send(self, linear, angular):
        msg = Twist()
        msg.linear.x, msg.angular.z = float(linear), float(angular)
        self.pub.publish(msg)

    def tick(self):
        if self.started is None:
            if time.monotonic()-self.waiting_since > 10:
                self.get_logger().error("10 秒未发现 turtlesim；检查命名空间和 ROS_DOMAIN_ID")
                self.done, self.failed = True, True
            return
        elapsed = time.monotonic()-self.started
        self.send(*command(elapsed))
        if elapsed >= DURATION+0.5:
            self.done = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="ros_pose.csv")
    args = parser.parse_args()
    if not all(math.isfinite(v) for v in (LINEAR, ANGULAR, DURATION)) or not (0 < LINEAR <= 1 and 0.5 <= abs(ANGULAR) <= 1 and 0 < DURATION <= 13):
        parser.error("本课参数范围：0 < LINEAR <= 1、0.5 <= |ANGULAR| <= 1、0 < DURATION <= 13")
    try:
        with Path(args.output).open("x", newline="", encoding="utf-8") as handle:
            rclpy.init(args=[])
            node = CircleRecorder(handle)
            try:
                while rclpy.ok() and not node.done:
                    rclpy.spin_once(node, timeout_sec=0.1)
            except KeyboardInterrupt:
                node.failed = True
            finally:
                if rclpy.ok():
                    for _ in range(3):
                        node.send(0, 0)
                        rclpy.spin_once(node, timeout_sec=0.05)
                node.destroy_node()
                if rclpy.ok():
                    rclpy.shutdown()
            return int(node.failed)
    except OSError as error:
        print("不能创建日志（不覆盖旧文件）：", error)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
