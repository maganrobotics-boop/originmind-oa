#!/usr/bin/env bash
# Actual ROS2 topics, not the analytic simulator. Run in an isolated Jazzy environment.
set -eo pipefail
source /opt/ros/jazzy/setup.bash
set -u
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
lesson_dir="$repo_dir/chat-cloudflare/public/assets/newbie-course-v1/ros2-simulation"
evidence_dir="$repo_dir/ros2-evidence"
mkdir -p "$evidence_dir"
export QT_QPA_PLATFORM=${QT_QPA_PLATFORM:-offscreen}
export ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-42}
export ROS_LOCALHOST_ONLY=1
sim_pid=''
cleanup() {
  if [ -n "$sim_pid" ]; then
    kill "$sim_pid" 2>/dev/null || true
    wait "$sim_pid" 2>/dev/null || true
    sim_pid=''
  fi
}
trap cleanup EXIT
dpkg-query -W ros-jazzy-turtlesim ros-jazzy-rclpy > "$evidence_dir/versions.txt"
cat "$evidence_dir/versions.txt"
for variant in standard half-speed reverse; do
  work="$evidence_dir/$variant"
  mkdir -p "$work"
  cp "$lesson_dir/"*.py "$work/"
  if [ "$variant" = half-speed ]; then sed -i 's/LINEAR = 1.0/LINEAR = 0.5/' "$work/motion.py"; fi
  if [ "$variant" = reverse ]; then sed -i 's/ANGULAR = 1.0/ANGULAR = -1.0/' "$work/motion.py"; fi
  ros2 run turtlesim turtlesim_node --ros-args -r __ns:=/newbie_lab > "$work/turtlesim.log" 2>&1 &
  sim_pid=$!
  timeout 25s python3 "$work/run_ros.py" --output "$work/ros_pose.csv" 2>&1 | tee "$work/recorder.log"
  timeout 10s ros2 node list > "$work/nodes.txt"
  timeout 10s ros2 topic list -t > "$work/topics.txt"
  grep -F '/newbie_lab/turtlesim' "$work/nodes.txt"
  grep -F '/newbie_lab/turtle1/pose [turtlesim/msg/Pose]' "$work/topics.txt"
  radius=1
  if [ "$variant" = half-speed ]; then radius=0.5; fi
  python3 "$work/check_pose.py" "$work/ros_pose.csv" --radius "$radius" | tee "$work/check.txt"
  cleanup
  echo "REAL_ROS2_PASS: $variant"
done
