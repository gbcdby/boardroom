#!/usr/bin/python3
"""只在 unshare 创建的新 netns 内配置 loopback，再 exec 固定的 bwrap argv。"""
import fcntl
import os
import socket
import struct
import sys

try:
    # 不使用 ip/netlink：部分容器禁用 NETLINK_ROUTE，但支持隔离 netns + ioctl。
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    flags = fcntl.ioctl(sock.fileno(), 0x8913, struct.pack("16sh", b"lo", 0))
    current = struct.unpack("16sh", flags[:18])[1]
    fcntl.ioctl(sock.fileno(), 0x8914, struct.pack("16sh", b"lo", current | 1))
    sock.close()
    if len(sys.argv) < 2 or sys.argv[1] != "/usr/bin/bwrap":
        raise ValueError("invalid_launcher")
    os.execv(sys.argv[1], sys.argv[1:])
except Exception:
    # 不输出系统异常或 argv：其中可能有路径和提示内容。
    sys.stderr.write("isolation_unavailable\n")
    sys.exit(78)
