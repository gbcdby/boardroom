"""A real same-UID source user. Only this process's resources are released."""
import ctypes
import json
import os
import sys

file, mode = sys.argv[1:]
fd = None
mapping = None
length = 0
libc = ctypes.CDLL(None, use_errno=True)
libc.mmap.restype = ctypes.c_void_p
libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
report = {"pid": os.getpid(), "uid": os.getuid(), "mode": mode}
try:
    if mode != "idle":
        fd = os.open(file, os.O_RDWR if mode == "shared-writer" else os.O_RDONLY)
        info = os.fstat(fd)
        report["sourceStat"] = {"device": str(info.st_dev), "inode": str(info.st_ino)}
        with open(f"/proc/self/fdinfo/{fd}") as metadata:
            report["sourceFdinfo"] = metadata.read()
        if mode != "fd-reader":
            length = info.st_size
            mapping = libc.mmap(None, length, 3 if mode == "shared-writer" else 1,
                                1 if mode == "shared-writer" else 2, fd, 0)
            if mapping == ctypes.c_void_p(-1).value:
                raise OSError(ctypes.get_errno(), "mmap failed")
            os.close(fd)
            fd = None
            if mode == "shared-writer":
                byte = ctypes.c_ubyte.from_address(mapping)
                byte.value = byte.value  # Actual writable access, without changing DB contents.
                report["sameByteWrite"] = True
            with open("/proc/self/maps") as metadata:
                report["mapping"] = next(line.rstrip("\n") for line in metadata
                                         if int(line.split("-", 1)[0], 16) == mapping)
    report["sourceFdClosed"] = fd is None
    print(json.dumps(report), flush=True)
    sys.stdin.readline()
finally:
    if mapping is not None and mapping != ctypes.c_void_p(-1).value:
        if libc.munmap(mapping, length) != 0:
            raise OSError(ctypes.get_errno(), "munmap failed")
    if fd is not None:
        os.close(fd)
