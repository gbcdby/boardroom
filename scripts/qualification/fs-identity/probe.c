/* #152 的有限原生实验；不是生产 provider，不解析 opaque FID 的内部布局。 */
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

/* 固定 Linux v6.18 UAPI，来源及摘要见 profile.json。
 * 只补缺失声明；没有相应 ABI 时编译失败，不修改系统头或猜 syscall 号。
 * https://github.com/torvalds/linux/blob/v6.18/include/uapi/linux/{fs,fcntl,stat}.h
 */
#if !defined(__linux__) || !(defined(__x86_64__) || defined(__aarch64__))
#error "This qualification only declares the Linux x86_64/aarch64 64-bit ABI"
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
  int shape = fr == 0 && (unsigned long)fs.f_type == 0x794c7630UL && qr == 0 &&
              uuid.len == 16 && nonzero && hr == 0 && handle->handle_type == 248 &&
              handle->handle_bytes == 32 && ur == 0 &&
              (unique.stx_mask & STATX_MNT_ID_UNIQUE) && mount_id != 0 &&
              unique.stx_mnt_id == mount_id;
  printf("{\"kind\":\"native-observation\",\"object\":"); quoted(label);
  printf(",\"mode\":"); quoted(mode);
  printf(",\"pid\":%d,\"fd\":%d,\"iteration\":%d,\"before_rc\":%d,"
         "\"before_errno\":%d,\"before\":", getpid(), fd, iteration, br, be);
  metadata(&before);
  printf(",\"fs_rc\":%d,\"fs_errno\":%d,\"fs_magic\":\"%lx\","
         "\"statx_legacy\":{\"rc\":%d,\"errno\":%d,\"mask\":%u,\"mount_id\":\"%"PRIu64"\"},"
         "\"statx_unique\":{\"rc\":%d,\"errno\":%d,\"mask\":%u,\"mount_id\":\"%"PRIu64"\","
         "\"btime\":[\"%jd\",\"%u\"]},\"fsuuid\":{\"rc\":%d,\"errno\":%d,\"length\":%u,\"hex\":",
         fr, fe, (unsigned long)fs.f_type, lr, le, legacy.stx_mask, (uint64_t)legacy.stx_mnt_id,
         ur, ue, unique.stx_mask, (uint64_t)unique.stx_mnt_id,
         (intmax_t)unique.stx_btime.tv_sec, unique.stx_btime.tv_nsec, qr, qe, uuid.len);
  hex(uuid.uuid, uuid.len <= 16 ? uuid.len : 16);
  printf("},\"fid_unique\":{\"rc\":%ld,\"errno\":%d,\"mount_id\":\"%"PRIu64"\","
         "\"handle_type\":%d,\"handle_bytes\":%u,\"hex\":", hr, he, mount_id,
         handle->handle_type, handle->handle_bytes);
  hex(handle->f_handle, hr == 0 && handle->handle_bytes <= 128 ? handle->handle_bytes : 0);
  printf("},\"after_rc\":%d,\"after_errno\":%d,\"after\":", ar, ae);
  metadata(&after);
  printf(",\"same_fd_metadata_stable\":%s,\"strict_shape\":%s}\n",
         same ? "true" : "false", shape ? "true" : "false");
  if (!same) return 70;
  return strcmp(mode, "lookup") == 0 || shape ? 0 : 69;
}

int main(int argc, char **argv) {
  /* mode uid gid mount-root [label relative-path file|directory]... */
  if (argc < 8 || argc > 23 || (argc - 5) % 3 != 0 ||
      (strcmp(argv[1], "lookup") && strcmp(argv[1], "provider"))) return 64;
  char *end = NULL;
  unsigned long uid = strtoul(argv[2], &end, 10);
  if (!*argv[2] || *end || uid == 0 || uid > UINT32_MAX) return 64;
  unsigned long gid = strtoul(argv[3], &end, 10);
  if (!*argv[3] || *end || gid == 0 || gid > UINT32_MAX || argv[4][0] != '/') return 64;
  if (!identity((unsigned)uid, (unsigned)gid)) return 77;
  int root = open(argv[4], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NOATIME);
  if (root < 0) { printf("{\"kind\":\"open-root-error\",\"errno\":%d}\n", errno); return 69; }
  int result = 0;
  for (int i = 5; i < argc; i += 3) {
    int directory = !strcmp(argv[i + 2], "directory");
    if ((!directory && strcmp(argv[i + 2], "file")) || !*argv[i + 1] ||
        strchr(argv[i + 1], '/') || !strcmp(argv[i + 1], "..")) { result = 64; break; }
    int flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | O_NOATIME;
    if (directory) flags |= O_DIRECTORY;
    int fd = openat(root, argv[i + 1], flags);
    if (fd < 0) {
      printf("{\"kind\":\"open-error\",\"object\":"); quoted(argv[i]);
      printf(",\"errno\":%d}\n", errno); result = 69; continue;
    }
    struct stat st = {0};
    if (fstat(fd, &st) || st.st_uid != uid || st.st_gid != gid ||
        (directory ? !S_ISDIR(st.st_mode) : (!S_ISREG(st.st_mode) || st.st_nlink != 1))) {
      printf("{\"kind\":\"object-guard-error\",\"object\":"); quoted(argv[i]);
      puts("}"); result = 70; close(fd); continue;
    }
    for (int iteration = 0; iteration < (strcmp(argv[1], "provider") ? 1 : 2); ++iteration) {
      int rc = observe(fd, argv[i], argv[1], iteration);
      if (rc > result) result = rc;
    }
    close(fd);
  }
  close(root);
  return result;
}
