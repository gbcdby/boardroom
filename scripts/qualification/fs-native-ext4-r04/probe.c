/* #152 R04 d1 隔离取证；前缀复用已审 b960 的只读身份/原生观察，不是生产 provider。 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/fs.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <signal.h>
#include <linux/openat2.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <sys/utsname.h>
#include <ctype.h>
#include <limits.h>
#include "uapi.h"

/* 固定 Linux v6.18 UAPI，来源及摘要见 profile.json。
 * 只补缺失声明；没有相应 ABI 时编译失败，不修改系统头或猜 syscall 号。
 * https://github.com/torvalds/linux/blob/v6.18/include/uapi/linux/{fs,fcntl,stat}.h
 */
#if !defined(__linux__) || !defined(__x86_64__)
#error "This qualification only declares the Linux x86_64 64-bit ABI"
#endif
#ifndef SYS_name_to_handle_at
#error "SYS_name_to_handle_at is unavailable in the installed UAPI"
#endif
#ifndef SYS_statx
#error "SYS_statx is unavailable in the installed UAPI"
#endif
#ifndef FS_IOC_GETFSUUID
struct fsuuid2 { uint8_t len; uint8_t uuid[16]; };
#define FS_IOC_GETFSUUID _IOR(0x15, 0, struct fsuuid2)
#endif
#ifndef AT_HANDLE_FID
#define AT_HANDLE_FID 0x200
#endif
#ifndef AT_HANDLE_MNT_ID_UNIQUE
#define AT_HANDLE_MNT_ID_UNIQUE 0x001
#endif
#ifndef STATX_MNT_ID_UNIQUE
#define STATX_MNT_ID_UNIQUE 0x00004000U
#endif
_Static_assert(sizeof(struct open_how) == 24, "openat2 UAPI size");
_Static_assert(offsetof(struct statx, stx_attributes_mask) == 56, "statx attribute mask offset");
_Static_assert(sizeof(void *) == 8 && sizeof(uint64_t) == 8, "64-bit ABI required");
_Static_assert(sizeof(struct fsuuid2) == 17, "fsuuid2 UAPI size");
_Static_assert(offsetof(struct fsuuid2, len) == 0, "fsuuid2 length offset");
_Static_assert(offsetof(struct fsuuid2, uuid) == 1, "fsuuid2 UUID offset");
_Static_assert(FS_IOC_GETFSUUID == 0x80111500UL, "GETFSUUID ioctl encoding");
_Static_assert(AT_HANDLE_FID == 0x200 && AT_HANDLE_MNT_ID_UNIQUE == 1, "handle flags");
_Static_assert(STATX_MNT_ID_UNIQUE == 0x4000, "unique mount mask");
_Static_assert(sizeof(struct statx) == 256, "statx UAPI size");
_Static_assert(offsetof(struct statx, stx_mnt_id) == 144, "statx mount offset");
_Static_assert(sizeof(((struct statx *)0)->stx_mnt_id) == 8, "64-bit mount slot");
_Static_assert(offsetof(struct file_handle, f_handle) == 8, "file_handle UAPI header");
_Static_assert(sizeof(struct file_handle) == 8, "file_handle UAPI size");

static void quoted(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
    if (*p == '"' || *p == '\\') printf("\\%c", *p);
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}

static void hex(const void *p, size_t n) {
  const unsigned char *b = p;
  putchar('"');
  for (size_t i = 0; i < n; ++i) printf("%02x", b[i]);
  putchar('"');
}

static void metadata(const struct stat *s) {
  printf("{\"dev\":\"%ju\",\"ino\":\"%ju\",\"mode\":\"%ju\","
         "\"nlink\":\"%ju\",\"size\":\"%jd\",\"uid\":%u,\"gid\":%u,"
         "\"atime\":[\"%jd\",\"%ld\"],\"mtime\":[\"%jd\",\"%ld\"],"
         "\"ctime\":[\"%jd\",\"%ld\"]}",
         (uintmax_t)s->st_dev, (uintmax_t)s->st_ino, (uintmax_t)s->st_mode,
         (uintmax_t)s->st_nlink, (intmax_t)s->st_size, s->st_uid, s->st_gid,
         (intmax_t)s->st_atim.tv_sec, s->st_atim.tv_nsec,
         (intmax_t)s->st_mtim.tv_sec, s->st_mtim.tv_nsec,
         (intmax_t)s->st_ctim.tv_sec, s->st_ctim.tv_nsec);
}

static int identity(unsigned expected_uid, unsigned expected_gid) {
  const char *keys[] = {"CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"};
  unsigned long long caps[5] = {0};
  int seen[5] = {0}, ok = 1;
  unsigned proc_uid[4] = {0}, proc_gid[4] = {0};
  int uid_seen = 0, gid_seen = 0;
  uid_t ruid = 0, euid = 0, suid = 0;
  gid_t rgid = 0, egid = 0, sgid = 0;
  char line[512];
  FILE *f = fopen("/proc/self/status", "re");
  if (!f) return 0;
  while (fgets(line, sizeof(line), f)) {
    if (!strncmp(line, "Uid:", 4))
      uid_seen = sscanf(line + 4, "%u %u %u %u", &proc_uid[0], &proc_uid[1], &proc_uid[2], &proc_uid[3]) == 4;
    if (!strncmp(line, "Gid:", 4))
      gid_seen = sscanf(line + 4, "%u %u %u %u", &proc_gid[0], &proc_gid[1], &proc_gid[2], &proc_gid[3]) == 4;
    for (int i = 0; i < 5; ++i) {
      if (strncmp(line, keys[i], strlen(keys[i])) == 0)
        seen[i] = sscanf(line + strlen(keys[i]), "%llx", &caps[i]) == 1;
    }
  }
  fclose(f);
  int groups = getgroups(0, NULL);
  int nnp = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  ok = getresuid(&ruid, &euid, &suid) == 0 && getresgid(&rgid, &egid, &sgid) == 0;
  ok = ok && expected_uid != 0 && expected_gid != 0 &&
       ruid == expected_uid && euid == expected_uid && suid == expected_uid &&
       rgid == expected_gid && egid == expected_gid && sgid == expected_gid &&
       groups == 0 && nnp == 1;
  for (int i = 0; i < 5; ++i) ok = ok && seen[i] && caps[i] == 0;
  ok = ok && uid_seen && gid_seen && proc_uid[3] == expected_uid && proc_gid[3] == expected_gid;
  printf("{\"kind\":\"process-identity\",\"pid\":%d,\"uid\":[%u,%u,%u,%u],"
         "\"gid\":[%u,%u,%u,%u],\"supplementary_group_count\":%d,"
         "\"no_new_privs\":%d,\"capabilities\":{", getpid(), ruid, euid, suid, proc_uid[3],
         rgid, egid, sgid, proc_gid[3], groups, nnp);
  for (int i = 0; i < 5; ++i)
    printf("%s\"%.*s\":\"%016llx\"", i ? "," : "", (int)strlen(keys[i]) - 1,
           keys[i], caps[i]);
  printf("},\"verified\":%s}\n", ok ? "true" : "false");
  return ok;
}

static int stable(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
         a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
         a->st_size == b->st_size && a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
         a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
         a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}

static int observe(int fd, const char *label, const char *mode, int iteration) {
  struct stat before = {0}, after = {0};
  struct statfs fs = {0};
  struct statx legacy = {0}, unique = {0};
  struct fsuuid2 uuid = {0};
  /* 同一次调用只有一个 128-byte 缓冲，不对 EOVERFLOW 扩容或重试。 */
  union { max_align_t align; unsigned char raw[sizeof(struct file_handle) + 128]; } buf = {0};
  struct file_handle *handle = (struct file_handle *)buf.raw;
  uint64_t mount_id = 0;
  errno = 0; int br = fstat(fd, &before), be = errno;
  int fr = -2, fe = 0, lr = -2, le = 0, ur = -2, ue = 0, qr = -2, qe = 0;
  long hr = -2; int he = 0;
  if (strcmp(mode, "provider") == 0) {
    errno = 0; fr = fstatfs(fd, &fs); fe = errno;
    errno = 0; lr = (int)syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
                               STATX_BASIC_STATS | STATX_MNT_ID, &legacy); le = errno;
    errno = 0; ur = (int)syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
                               STATX_BASIC_STATS | STATX_BTIME | STATX_MNT_ID_UNIQUE, &unique); ue = errno;
    errno = 0; qr = ioctl(fd, FS_IOC_GETFSUUID, &uuid); qe = errno;
    handle->handle_bytes = 128;
    errno = 0; hr = syscall(SYS_name_to_handle_at, fd, "", handle, &mount_id,
                           AT_EMPTY_PATH | AT_HANDLE_FID | AT_HANDLE_MNT_ID_UNIQUE); he = errno;
  }
  errno = 0; int ar = fstat(fd, &after), ae = errno;
  unsigned char nonzero = 0;
  for (size_t i = 0; i < sizeof(uuid.uuid); ++i) nonzero |= uuid.uuid[i];
  int same = br == 0 && ar == 0 && stable(&before, &after);
  int statx_match = lr == 0 && ur == 0 && legacy.stx_ino == before.st_ino && unique.stx_ino == before.st_ino &&
      legacy.stx_mode == before.st_mode && unique.stx_mode == before.st_mode &&
      legacy.stx_uid == before.st_uid && unique.stx_uid == before.st_uid &&
      legacy.stx_gid == before.st_gid && unique.stx_gid == before.st_gid &&
      legacy.stx_size == (uint64_t)before.st_size && unique.stx_size == (uint64_t)before.st_size &&
      makedev(legacy.stx_dev_major,legacy.stx_dev_minor)==before.st_dev &&
      makedev(unique.stx_dev_major,unique.stx_dev_minor)==before.st_dev;
  int shape = statx_match && (legacy.stx_mask & 0x17ff)==0x17ff && (unique.stx_mask & 0x4fff)==0x4fff &&
              (unique.stx_attributes_mask & 0x200000) && !(unique.stx_attributes & 0x200000) && fr == 0 && (unsigned long)fs.f_type == 0xef53UL && qr == 0 &&
              uuid.len == 16 && nonzero && hr == 0 && handle->handle_type == 1 &&
              handle->handle_bytes == 8 && ur == 0 &&
              (unique.stx_mask & STATX_MNT_ID_UNIQUE) && mount_id != 0 &&
              unique.stx_mnt_id == mount_id;
  printf("{\"kind\":\"native-observation\",\"object\":"); quoted(label);
  printf(",\"mode\":"); quoted(mode);
  printf(",\"pid\":%d,\"fd\":%d,\"iteration\":%d,\"before_rc\":%d,"
         "\"before_errno\":%d,\"before\":", getpid(), fd, iteration, br, be);
  metadata(&before);
  printf(",\"fs_rc\":%d,\"fs_errno\":%d,\"fs_magic\":\"%lx\","
         "\"statx_legacy\":{\"rc\":%d,\"errno\":%d,\"requested_mask\":6143,\"mask\":%u,\"mount_id\":\"%"PRIu64"\",\"dev_major\":%u,\"dev_minor\":%u},"
         "\"statx_unique\":{\"rc\":%d,\"errno\":%d,\"requested_mask\":20479,\"mask\":%u,\"mount_id\":\"%"PRIu64"\","
         "\"btime\":[\"%jd\",\"%u\"],\"attributes\":\"%"PRIu64"\",\"attributes_mask\":\"%"PRIu64"\"},\"fsuuid\":{\"rc\":%d,\"errno\":%d,\"length\":%u,\"hex\":",
         fr, fe, (unsigned long)fs.f_type, lr, le, legacy.stx_mask, (uint64_t)legacy.stx_mnt_id, legacy.stx_dev_major, legacy.stx_dev_minor,
         ur, ue, unique.stx_mask, (uint64_t)unique.stx_mnt_id,
         (intmax_t)unique.stx_btime.tv_sec, unique.stx_btime.tv_nsec, (uint64_t)unique.stx_attributes, (uint64_t)unique.stx_attributes_mask, qr, qe, uuid.len);
  hex(uuid.uuid, uuid.len <= 16 ? uuid.len : 16);
  printf("},\"fid_unique\":{\"rc\":%ld,\"errno\":%d,\"mount_id\":\"%"PRIu64"\","
         "\"handle_type\":%d,\"handle_bytes\":%u,\"hex\":", hr, he, mount_id,
         handle->handle_type, handle->handle_bytes);
  hex(handle->f_handle, hr == 0 && handle->handle_bytes <= 128 ? handle->handle_bytes : 0);
  printf("},\"after_rc\":%d,\"after_errno\":%d,\"after\":", ar, ae);
  metadata(&after);
  printf(",\"same_fd_metadata_stable\":%s,\"statx_metadata_matches\":%s,\"strict_shape\":%s}\n",
         same ? "true" : "false", statx_match ? "true" : "false", shape ? "true" : "false");
  if (!same) return 70;
  return strcmp(mode, "lookup") == 0 || shape ? 0 : 69;
}

static void step(const char *action, const char *role, int fd, int rc, int error) {
  struct timespec t={0}; clock_gettime(CLOCK_MONOTONIC,&t);
  printf("{\"kind\":\"step\",\"pid\":%d,\"action\":",getpid());quoted(action);
  printf(",\"role\":");quoted(role);
  printf(",\"fd\":%d,\"rc\":%d,\"errno\":%d,\"monotonic_ns\":\"%jd\"}\n",
         fd,rc,error,(intmax_t)t.tv_sec*1000000000+t.tv_nsec);fflush(stdout);
}

static int open_beneath(int root,const char *path,uint64_t flags,int symlinks) {
  struct open_how h={.flags=flags|O_CLOEXEC,
    .resolve=RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS|(symlinks?0:RESOLVE_NO_SYMLINKS)};
  return (int)syscall(SYS_openat2,root,path,&h,sizeof(h));
}

/* 只打开固定 kernel pseudo-FS；返回的全原字节供离线消费者独立解析。 */
static void pseudo(int root,const char *relative,const char *name,const char *phase,
                   size_t limit,unsigned long required_magic,int symlinks) {
  unsigned char *buf=calloc(1,limit+1);struct stat st={0};struct statfs fs={0};
  int error=0,rc=0;size_t n=0;
  int fd=open_beneath(root,relative,O_RDONLY|O_NOFOLLOW|O_NONBLOCK,symlinks);
  if(!buf){if(fd>=0)close(fd);exit(71);}
  if(fd<0){rc=-1;error=errno;}
  else if(fstat(fd,&st)||fstatfs(fd,&fs)){rc=-1;error=errno;}
  else if(!S_ISREG(st.st_mode)||(unsigned long)fs.f_type!=required_magic){rc=-1;error=EXDEV;}
  else for(;;){ssize_t k=read(fd,buf+n,limit+1-n);
    if(k<0){rc=-1;error=errno;break;}if(!k)break;n+=(size_t)k;
    if(n>limit){rc=-1;error=EOVERFLOW;break;}}
  printf("{\"kind\":\"pseudo\",\"pid\":%d,\"name\":",getpid());quoted(name);
  printf(",\"phase\":");quoted(phase);printf(",\"relative\":");quoted(relative);
  printf(",\"rc\":%d,\"errno\":%d,\"fs_magic\":\"%lx\",\"dev\":\"%ju\",\"ino\":\"%ju\",\"hex\":",
         rc,error,(unsigned long)fs.f_type,(uintmax_t)st.st_dev,(uintmax_t)st.st_ino);
  hex(buf,n);puts("}");free(buf);
  if(fd>=0){errno=0;int cr=close(fd),ce=errno;step("close","pseudo",fd,cr,ce);}
}

static int pseudo_root(const char *path,unsigned long magic) {
  int fd=open(path,O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct statfs fs={0};
  if(fd>=0&&(fstatfs(fd,&fs)||(unsigned long)fs.f_type!=magic)){close(fd);fd=-1;errno=EXDEV;}
  return fd;
}

static void configuration(int fd,const char *phase) {
  struct stat st={0};int sr=fstat(fd,&st);
  int sys=pseudo_root("/sys",0x62656572UL),proc=pseudo_root("/proc",0x9fa0UL);
  if(sys<0||proc<0||sr){step("pseudo-root-error","context",fd,-1,errno);goto done;}
  pseudo(proc,"self/mountinfo","mountinfo",phase,1048576,0x9fa0UL,1);
  char path[128],link[64],resolved[PATH_MAX]={0};
  snprintf(path,sizeof(path),"dev/block/%u:%u",major(st.st_dev),minor(st.st_dev));
  int dev=open_beneath(sys,path,O_PATH|O_DIRECTORY,1);struct stat ds={0};struct statfs dfs={0};
  if(dev<0){step("sysfs-device-error","context",fd,-1,errno);goto done;}
  snprintf(link,sizeof(link),"/proc/self/fd/%d",dev);
  ssize_t len=readlink(link,resolved,sizeof(resolved)-1);
  int ok=len>0&&len<(ssize_t)sizeof(resolved)-1&&fstat(dev,&ds)==0&&fstatfs(dev,&dfs)==0&&
    (unsigned long)dfs.f_type==0x62656572UL&&!strncmp(resolved,"/sys/devices/",13);
  char *name=strrchr(resolved,'/');name=name?name+1:resolved;
  ok=ok&&strlen(name)>0&&strlen(name)<32;
  for(char *p=name;*p;p++)if(!isalnum((unsigned char)*p)&&*p!='_'&&*p!='.'&&*p!='-')ok=0;
  printf("{\"kind\":\"sysfs-binding\",\"phase\":");quoted(phase);
  printf(",\"source_fd\":%d,\"dev_major\":%u,\"dev_minor\":%u,\"sysfs_inode\":\"%ju\",\"sysfs_dev\":\"%ju\",\"resolved\":",
         fd,major(st.st_dev),minor(st.st_dev),(uintmax_t)ds.st_ino,(uintmax_t)ds.st_dev);
  quoted(resolved);printf(",\"sb_id\":");quoted(name);printf(",\"valid_name\":%s}\n",ok?"true":"false");
  pseudo(dev,"dev","device-dev",phase,4096,0x62656572UL,0);
  pseudo(dev,"uevent","device-uevent",phase,4096,0x62656572UL,0);
  pseudo(dev,"partition","device-partition",phase,4096,0x62656572UL,0);
  pseudo(dev,"loop/backing_file","loop-backing-path-only",phase,4096,0x62656572UL,0);
  if(ok){snprintf(path,sizeof(path),"fs/ext4/%s/options",name);
    pseudo(proc,path,"proc-options",phase,16384,0x9fa0UL,0);}
  {errno=0;int cr=close(dev),ce=errno;step("close","sysfs-device",dev,cr,ce);}
done:
  if(sys>=0){errno=0;int cr=close(sys),ce=errno;step("close","sysfs-root",sys,cr,ce);}
  if(proc>=0){errno=0;int cr=close(proc),ce=errno;step("close","proc-root",proc,cr,ce);}
}

static void extra(int fd,const char *label) {
  struct statx sx={0};struct r04_tune tune={0};long flags=0;
  errno=0;int xr=(int)syscall(SYS_statx,fd,"",AT_EMPTY_PATH|AT_SYMLINK_NOFOLLOW,
    STATX_BASIC_STATS|STATX_BTIME|STATX_MNT_ID_UNIQUE,&sx),xe=errno;
  errno=0;int tr=ioctl(fd,R04_GET_TUNE,&tune),te=errno;
  errno=0;int ir=ioctl(fd,FS_IOC_GETFLAGS,&flags),ie=errno;
  union{max_align_t align;unsigned char bytes[16384];} mb={0};
  struct r04_mnt_id_req req={.size=sizeof(req),.mnt_id=sx.stx_mnt_id,.param=R04_MOUNT_MASK};
  errno=0;int mr=xr==0?(int)syscall(SYS_statmount,&req,mb.bytes,sizeof(mb.bytes),0):-1;
  int me=xr==0?errno:EINVAL;struct r04_statmount *sm=(void *)mb.bytes;
  size_t mlen=mr==0&&sm->size>=512&&sm->size<=sizeof(mb.bytes)?sm->size:sizeof(mb.bytes);
  printf("{\"kind\":\"r04-extra\",\"pid\":%d,\"fd\":%d,\"label\":",getpid(),fd);quoted(label);
  printf(",\"statx\":{\"rc\":%d,\"errno\":%d,\"hex\":",xr,xe);hex(&sx,sizeof(sx));
  printf("},\"tune\":{\"rc\":%d,\"errno\":%d,\"ioctl\":\"%lx\",\"hex\":",tr,te,(unsigned long)R04_GET_TUNE);hex(&tune,sizeof(tune));
  printf("},\"flags\":{\"rc\":%d,\"errno\":%d,\"hex\":",ir,ie);hex(&flags,sizeof(flags));
  printf("},\"statmount\":{\"rc\":%d,\"errno\":%d,\"flags\":0,\"request_hex\":",mr,me);hex(&req,sizeof(req));
  printf(",\"hex\":");hex(mb.bytes,mlen);puts("}}");
}

static void opath(int root,const char *name,const char *label) {
  int fd=open_beneath(root,name,O_PATH|O_NOFOLLOW,0),error=errno;
  struct statx sx={0};int rc=fd<0?-1:(int)syscall(SYS_statx,fd,"",AT_EMPTY_PATH|AT_SYMLINK_NOFOLLOW,
    STATX_BASIC_STATS|STATX_BTIME|STATX_MNT_ID_UNIQUE,&sx);
  if(rc<0&&fd>=0)error=errno;
  printf("{\"kind\":\"opath\",\"pid\":%d,\"label\":",getpid());quoted(label);
  printf(",\"fd\":%d,\"rc\":%d,\"errno\":%d,\"statx_hex\":",fd,rc,rc<0?error:0);hex(&sx,sizeof(sx));puts("}");
  if(fd>=0){errno=0;int cr=close(fd),ce=errno;step("close","opath",fd,cr,ce);}
}

static int source_open(int root,const char *path,int dir) {
  struct open_how h={.flags=O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK|O_NOATIME|(dir?O_DIRECTORY:0),
    .resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV};
  return (int)syscall(SYS_openat2,root,path,&h,sizeof(h));
}

int main(int argc,char **argv) {
  if(argc==2&&!strcmp(argv[1],"--abi")){
    printf("{\"tune_bytes\":%zu,\"statmount_header_bytes\":%zu,\"request_bytes\":%zu,\"statmount_syscall\":%d,\"runtime_probe\":false}\n",
      sizeof(struct r04_tune),sizeof(struct r04_statmount),sizeof(struct r04_mnt_id_req),SYS_statmount);return 0;}
  if(argc!=5||(strcmp(argv[1],"context")&&strcmp(argv[1],"ordinary")))return 64;
  char *end=NULL;unsigned long uid=strtoul(argv[2],&end,10);if(!*argv[2]||*end||!uid||uid>UINT32_MAX)return 64;
  unsigned long gid=strtoul(argv[3],&end,10);if(!*argv[3]||*end||!gid||gid>UINT32_MAX||argv[4][0]!='/')return 64;
  if(!identity((unsigned)uid,(unsigned)gid))return 77;
  struct utsname un={0};if(uname(&un))return 69;
  printf("{\"kind\":\"uname\",\"sysname\":");quoted(un.sysname);printf(",\"machine\":");quoted(un.machine);
  printf(",\"release\":");quoted(un.release);printf(",\"version\":");quoted(un.version);puts("}");
  int sys=pseudo_root("/sys",0x62656572UL),proc=pseudo_root("/proc",0x9fa0UL);
  if(sys>=0){pseudo(sys,"kernel/notes","kernel-notes","build",1048576,0x62656572UL,0);
    pseudo(sys,"module/ext4/notes/.note.gnu.build-id","ext4-module-note","build",4096,0x62656572UL,0);
    pseudo(sys,"module/ext4/srcversion","ext4-srcversion","build",4096,0x62656572UL,0);
    errno=0;int cr=close(sys),ce=errno;step("close","build-sysfs",sys,cr,ce);}
  if(proc>=0){pseudo(proc,"modules","loaded-modules","build",1048576,0x9fa0UL,0);
    errno=0;int cr=close(proc),ce=errno;step("close","build-proc",proc,cr,ce);}
  errno=0;int root=open(argv[4],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC|O_NOATIME),error=errno;
  step("open-directory","root",root,root<0?-1:0,error);
  if(root<0)return 69;
  struct stat rs={0};if(fstat(root,&rs)||rs.st_uid!=uid||rs.st_gid!=gid||!S_ISDIR(rs.st_mode)){close(root);return 70;}
  int result=observe(root,"root","provider",0);extra(root,"root-before");configuration(root,"before");
  opath(root,".","mount-root");opath(root,"payload","file-before");opath(root,"ancestor/missing","absent-leaf");
  int dir=source_open(root,"directory",1);step("open-directory","directory",dir,dir<0?-1:0,dir<0?errno:0);
  if(dir>=0){int rc=observe(dir,"directory","provider",0);if(rc>result)result=rc;extra(dir,"directory");
    errno=0;int cr=close(dir),ce=errno;step("close","directory",dir,cr,ce);if(cr)result=70;}
  else result=69;
  if(!strcmp(argv[1],"ordinary")){
    step("ordinary-open-attempt","payload",-1,0,0);
    errno=0;int fd=source_open(root,"payload",0),fe=errno;step("ordinary-open","payload",fd,fd<0?-1:0,fe);
    if(fd>=0){struct stat a={0},b={0};
      if(fstat(fd,&a)||!S_ISREG(a.st_mode)||a.st_uid!=uid||a.st_gid!=gid||a.st_nlink!=1){result=70;}
      else {
        int rc=observe(fd,"payload","provider",0);if(rc>result)result=rc;extra(fd,"payload-before");
        unsigned char *data=calloc(1,1048577);size_t n=0;int re=0;
        if(!data){close(fd);close(root);return 71;}
        for(;;){ssize_t k=read(fd,data+n,1048577-n);if(k<0){re=errno;break;}if(!k)break;n+=(size_t)k;
          if(n>1048576){re=EOVERFLOW;break;}}
        printf("{\"kind\":\"content\",\"pid\":%d,\"fd\":%d,\"errno\":%d,\"hex\":",getpid(),fd,re);hex(data,n);puts("}");free(data);
        if(re)result=70;
        rc=observe(fd,"payload","provider",1);if(rc>result)result=rc;extra(fd,"payload-after");
        int pathfd=open_beneath(root,"payload",O_PATH|O_NOFOLLOW,0);
        int good=pathfd>=0&&fstat(pathfd,&b)==0&&stable(&a,&b);
        printf("{\"kind\":\"payload-path-guard\",\"pid\":%d,\"fd\":%d,\"same\":%s}\n",getpid(),fd,good?"true":"false");
        if(!good)result=70;
        if(pathfd>=0){errno=0;int cr=close(pathfd),ce=errno;step("close","payload-path",pathfd,cr,ce);if(cr)result=70;}
      }
      errno=0;int cr=close(fd),ce=errno;step("close","payload",fd,cr,ce);if(cr)result=70;
    }else result=69;
  }
  opath(root,"payload","file-after");configuration(root,"after");extra(root,"root-after");
  int rc=observe(root,"root","provider",1);if(rc>result)result=rc;
  struct stat rp={0},rf={0};int root_ok=lstat(argv[4],&rp)==0&&fstat(root,&rf)==0&&stable(&rs,&rf)&&rp.st_dev==rf.st_dev&&rp.st_ino==rf.st_ino;
  printf("{\"kind\":\"root-path-guard\",\"same\":%s}\n",root_ok?"true":"false");if(!root_ok)result=70;
  errno=0;int cr=close(root),ce=errno;step("close","root",root,cr,ce);if(cr)result=70;
  printf("{\"kind\":\"complete\",\"pid\":%d,\"mode\":",getpid());quoted(argv[1]);printf(",\"status\":%d}\n",result);
  return result;
}
