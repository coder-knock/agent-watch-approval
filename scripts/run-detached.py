#!/usr/bin/env python3
"""把一条命令脱离当前会话运行，并把输出落盘。

**为什么需要它**：Agent 会话里跑的前台命令，会在「用户发送下一条消息」的瞬间
被一起杀掉。对于 `approval link` 这种「发完通知要等人在手表上点按钮」的任务，
这是致命的 —— 日志会停在等待中途，结果永远看不到（实测就丢了两次输出）。

**做法**：两次 fork + os.setsid()。第一次 fork 让调用者的 shell 立刻认为命令已结束；
setsid() 让孙进程成为新会话首进程；第二次 fork 保证它永远拿不到控制终端。
macOS 没有 setsid(1)，所以只能在 Python 里调 os.setsid()。

用法：
    scripts/run-detached.py --log /tmp/out.log -- node scripts/x.mjs arg1
    scripts/run-detached.py -- node scripts/x.mjs        # 不重定向，输出到 /dev/null

返回后立刻可用 `tail -f <log>` 跟进度，或用 --status 检查是否还在跑。
"""
import argparse
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--log", default=None,
                    help="标准输出/错误的落盘路径（默认丢弃）")
    ap.add_argument("--cd", default=None, help="子进程的工作目录")
    ap.add_argument("cmd", nargs=argparse.REMAINDER,
                    help="要运行的命令（用 -- 与前面的参数隔开）")
    args = ap.parse_args()

    cmd = args.cmd
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        print("错误：没有给命令。用法见 --help", file=sys.stderr)
        return 2

    if os.fork() > 0:
        # 父进程直接退出，让调用者的 shell 认为命令已经结束
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        # 确保不是会话首进程 —— 从此与调用者彻底无关
        os._exit(0)

    if args.cd:
        os.chdir(args.cd)

    devnull = os.open(os.devnull, os.O_RDWR)
    fd = devnull
    if args.log:
        fd = os.open(args.log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)   # stdin
    os.dup2(fd, 1)
    os.dup2(fd, 2)

    try:
        os.execvp(cmd[0], cmd)
    except OSError as e:
        os.write(2, f"无法执行 {cmd[0]}: {e}\n".encode())
        os._exit(127)


if __name__ == "__main__":
    sys.exit(main())
