"""仅 harness 的自有 fixture 观察。不会普通打开挂载内 regular source。"""
from __future__ import annotations
import fcntl
import errno
import os
from pathlib import Path
import stat
import struct
from support import Stop, stat_fields

# Linux v7.0 include/uapi/linux/loop.h; only LOOP_GET_STATUS64, never configure.
LOOP_GET_STATUS64 = 0x4c05


def loop_detached(loop,expected_rdev):
    """Lo_bound 以外 GET_STATUS64 返回 ENXIO；其它错误不是释放证明。"""
    fd=os.open(loop,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
    try:
        st=os.fstat(fd)
        if not stat.S_ISBLK(st.st_mode) or st.st_rdev!=expected_rdev:raise Stop('detach device identity changed','INCONCLUSIVE')
        try:fcntl.ioctl(fd,LOOP_GET_STATUS64,bytearray(232),True)
        except OSError as exc:
            if exc.errno==errno.ENXIO:return {'unconfigured':True,'errno':exc.errno,'loop_rdev':st.st_rdev}
            raise Stop('detach status unknown: '+str(exc),'INCONCLUSIVE') from None
        raise Stop('loop remains configured','INCONCLUSIVE')
    finally:os.close(fd)


def loop_binding(loop: str, image: Path, identity: list[int]):
    st = image.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != 0 or [st.st_dev,st.st_ino] != identity:
        raise Stop('owned image identity changed', 'INCONCLUSIVE')
    fd = os.open(loop,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
    try:
        ls = os.fstat(fd)
        if not stat.S_ISBLK(ls.st_mode): raise Stop('not owned loop device', 'INCONCLUSIVE')
        raw = bytearray(232); fcntl.ioctl(fd,LOOP_GET_STATUS64,raw,True)
        dev,ino,rdev,offset,limit = struct.unpack_from('<QQQQQ',raw)
        if [dev,ino] != identity or offset != 0 or limit != 0:
            raise Stop('loop backing physical object changed', 'INCONCLUSIVE')
        return {'image_identity':identity, 'loop_rdev':ls.st_rdev, 'loop_inode':ls.st_ino,
                'raw_loop_info64_hex':raw.hex(), 'scope':'harness ownership only; not ordinary production topology proof'}
    finally: os.close(fd)


def superblock(loop, image, identity):
    binding = loop_binding(loop,image,identity)
    fd = os.open(loop,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISBLK(st.st_mode) or st.st_rdev != binding['loop_rdev']:
            raise Stop('raw observer FD binding changed','INCONCLUSIVE')
        raw = os.pread(fd,1024,1024)
        if len(raw)!=1024 or raw[56:58]!=b'\x53\xef': raise Stop('raw SB unavailable','INCONCLUSIVE')
        if loop_binding(loop,image,identity)!=binding: raise Stop('raw observer loop changed','INCONCLUSIVE')
        return raw, binding
    finally: os.close(fd)


def source_view(point: Path):
    """O_PATH/lstat/xattr only. Content baseline is read offline through owned raw image.

    This explicitly does not reuse the Q03 observer (which opens regular files).
    All paths are fixed fixture names, not caller-supplied source paths.
    """
    root = os.open(point,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        root_stat = os.fstat(root); result = {}
        for name in ('.','payload','directory','ancestor'):
            before = os.stat(name,dir_fd=root,follow_symlinks=False)
            if not (stat.S_ISREG(before.st_mode) or stat.S_ISDIR(before.st_mode)) or before.st_dev!=root_stat.st_dev:
                raise Stop('observer source boundary changed','INCONCLUSIVE')
            fd = os.open(name,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root)
            try:
                held = os.fstat(fd)
                if [held.st_dev,held.st_ino] != [before.st_dev,before.st_ino]: raise Stop('O_PATH observer race','INCONCLUSIVE')
                path = point/name; names = sorted(os.listxattr(path,follow_symlinks=False))
                if len(names)>64: raise Stop('xattr count budget','INCONCLUSIVE')
                attrs = {}; total = 0
                for key in names:
                    value = os.getxattr(path,key,follow_symlinks=False); total += len(key.encode())+len(value)
                    if total>65536: raise Stop('xattr byte budget','INCONCLUSIVE')
                    attrs[key]=value.hex()
                after = os.stat(name,dir_fd=root,follow_symlinks=False)
                if stat_fields(before)!=stat_fields(after): raise Stop('path observer changed','INCONCLUSIVE')
                result[name]={'stat':stat_fields(held),'xattrs':attrs}
            finally: os.close(fd)
        if point.lstat().st_ino!=root_stat.st_ino or point.lstat().st_dev!=root_stat.st_dev:
            raise Stop('observer mountpoint replacement','INCONCLUSIVE')
        return {'ordinary_source_open_count':0,'method':'O_PATH+lstat+listxattr/getxattr; no regular read', 'objects':result}
    finally: os.close(root)
