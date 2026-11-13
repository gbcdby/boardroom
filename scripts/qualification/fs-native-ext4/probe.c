/* #152 的native-ext4有限原生实验；不是生产 provider，不解析 opaque FID 的内部布局。 */
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


static int safe_open(int root, const char *relative, int directory) {
  struct open_how how={.flags=O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK|O_NOATIME,
    .resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV};
  if(directory)how.flags|=O_DIRECTORY;
  return (int)syscall(SYS_openat2,root,relative,&how,sizeof(how));
}
static int content(int fd, const char *label, int directory) {
  unsigned char *buf=malloc(1048577); if(!buf)return 69;
  size_t total=0;int rc=0,error=0;
  if(!directory)for(;;){ssize_t n=read(fd,buf+total,1048577-total);
    if(n<0){rc=-1;error=errno;break;} if(!n)break;total+=(size_t)n;
    if(total>1048576){rc=-1;error=EFBIG;break;}}
  printf("{\"kind\":\"content-read\",\"object\":");quoted(label);
  printf(",\"pid\":%d,\"fd\":%d,\"rc\":%d,\"errno\":%d,\"bytes\":%zu,\"hex\":",getpid(),fd,rc,error,total);
  hex(buf,total);puts("}");free(buf);return rc?70:0;
}
int main(int argc,char **argv){
  /* mode uid gid trusted-fixture-root [label relative-path file|directory]... */
  if(argc<8 || argc>53 || (argc-5)%3)return 64;
  int lookup=!strcmp(argv[1],"lookup"),race=!strcmp(argv[1],"path-race"),reuse=!strcmp(argv[1],"fd-reuse");
  if(!lookup&&!race&&!reuse&&strcmp(argv[1],"provider"))return 64;
  char *end=NULL;unsigned long uid=strtoul(argv[2],&end,10);if(!*argv[2]||*end||uid==0||uid>UINT32_MAX)return 64;
  unsigned long gid=strtoul(argv[3],&end,10);if(!*argv[3]||*end||gid==0||gid>UINT32_MAX||argv[4][0]!='/')return 64;
  if(!identity((unsigned)uid,(unsigned)gid))return 77;
  int root=open(argv[4],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC|O_NOATIME);struct stat root_before={0};
  if(root<0||fstat(root,&root_before)||root_before.st_uid!=uid||root_before.st_gid!=gid){
    printf("{\"kind\":\"open-root-error\",\"errno\":%d}\n",errno);if(root>=0)close(root);return 69;}
  int result=0;
  for(int i=5;i<argc;i+=3){
    int directory=!strcmp(argv[i+2],"directory");
    if((!directory&&strcmp(argv[i+2],"file"))||!*argv[i+1]||argv[i+1][0]=='/'||strstr(argv[i+1],"..")){result=64;break;}
    int fd=safe_open(root,argv[i+1],directory);
    if(fd<0){printf("{\"kind\":\"open-error\",\"object\":");quoted(argv[i]);printf(",\"errno\":%d}\n",errno);result=69;continue;}
    struct stat opened={0};
    if(fstat(fd,&opened)||opened.st_uid!=uid||opened.st_gid!=gid||
       (directory?!S_ISDIR(opened.st_mode):(!S_ISREG(opened.st_mode)||opened.st_nlink!=1))){
      printf("{\"kind\":\"object-guard-error\",\"object\":");quoted(argv[i]);puts("}");result=70;
    }else{
      int rc=observe(fd,argv[i],lookup?"lookup":"provider",0);if(rc>result)result=rc;
      if(race){puts("{\"kind\":\"race-window\",\"test_only\":true}");fflush(stdout);raise(SIGSTOP);}
      if(reuse){
        int oldfd=fd;errno=0;int cr=close(fd),ce=errno;fd=-1;
        errno=0;int opened_null=cr==0?open("/dev/null",O_RDONLY|O_CLOEXEC):-1,oe=errno;
        int duplicated=-2,de=0,dup_attempted=opened_null>=0&&opened_null!=oldfd;
        if(opened_null>=0){
          if(opened_null==oldfd){fd=opened_null;}
          else{errno=0;duplicated=dup2(opened_null,oldfd);de=errno;
            int close_extra=close(opened_null);if(duplicated>=0)fd=oldfd;
            if(close_extra!=0){puts("{\"kind\":\"injection-close-error\"}");result=70;}}
        }
        printf("{\"kind\":\"fd-reuse-injection\",\"object\":");quoted(argv[i]);
        printf(",\"pid\":%d,\"old_fd\":%d,\"new_fd\":%d,\"close_rc\":%d,\"close_errno\":%d,"
               "\"open_rc\":%d,\"open_errno\":%d,\"dup_attempted\":%s,\"dup_rc\":%d,\"dup_errno\":%d,\"applied\":%s,\"test_only\":true}\n",
               getpid(),oldfd,fd,cr,ce,opened_null,oe,dup_attempted?"true":"false",duplicated,de,cr==0&&fd==oldfd?"true":"false");
      }
      if(!lookup){rc=content(fd,argv[i],directory);if(rc>result)result=rc;rc=observe(fd,argv[i],"provider",1);if(rc>result)result=rc;}
      struct stat held={0},current={0},root_after={0},root_path={0};int currentfd=safe_open(root,argv[i+1],directory);
      int same=currentfd>=0&&fstat(currentfd,&current)==0&&fstat(fd,&held)==0&&
        opened.st_dev==held.st_dev&&opened.st_ino==held.st_ino&&held.st_dev==current.st_dev&&held.st_ino==current.st_ino&&stable(&opened,&held);
      int root_ok=fstat(root,&root_after)==0&&lstat(argv[4],&root_path)==0&&stable(&root_before,&root_after)&&root_path.st_dev==root_after.st_dev&&root_path.st_ino==root_after.st_ino;
      if(currentfd>=0 && close(currentfd)!=0){puts("{\"kind\":\"path-check-close-error\"}");result=70;}
      printf("{\"kind\":\"path-guard\",\"object\":");quoted(argv[i]);printf(",\"same_object\":%s,\"root_stable\":%s}\n",same?"true":"false",root_ok?"true":"false");
      if(!same||!root_ok)result=70;
    }
    int closed=close(fd);printf("{\"kind\":\"fd-closed\",\"object\":");quoted(argv[i]);printf(",\"fd\":%d,\"rc\":%d}\n",fd,closed);if(closed)result=70;
  }
  int closed=close(root);printf("{\"kind\":\"root-closed\",\"fd\":%d,\"rc\":%d}\n",root,closed);
  return closed?70:result;
}
