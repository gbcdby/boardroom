/* #152: narrow Darwin maintenance operations. No shell, signals, file writes or arbitrary process control. */
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/acl.h>
#include <libproc.h>
#include <mach/vm_inherit.h>
#include <mach/vm_statistics.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <uuid/uuid.h>

#define MAX_SCOPES 16
#define MAX_PROCESSES 65536
#define MAX_FDS 1048576
#define MAX_REGIONS 262144

struct scope { const char *path; bool tree; bool exists; dev_t device; ino_t inode; };
static struct scope scopes[MAX_SCOPES];
static int scope_count;
static bool comma;

static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}
static int fail(void) {
  /* Do not disclose paths, host identifiers or process contents in errors. */
  fprintf(stderr, "maintenance_native_unavailable:%d\n", errno);
  return 1;
}
static void item_start(void) { if (comma) putchar(','); comma = true; }
static void unreadable(pid_t pid, const char *reason) {
  item_start(); printf("{\"kind\":\"unreadable\",\"pid\":%d,\"reason\":", pid);
  json_string(reason); putchar('}');
}
static bool owner_only(int fd, bool private_tree) {
  struct stat info; struct statfs filesystem;
  if (fstat(fd, &info) != 0 || fstatfs(fd, &filesystem) != 0) return false;
  if (info.st_uid != getuid() || (info.st_mode & 0022) != 0 || (private_tree && (info.st_mode & 0077) != 0)
      || strcmp(filesystem.f_fstypename, "apfs") != 0 || !(filesystem.f_flags & MNT_LOCAL)
      || (filesystem.f_flags & MNT_IGNORE_OWNERSHIP)) { errno = EPERM; return false; }
  errno = 0;
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT; /* Apple FILESEC_ACL absent on an already verified valid FD. */
  acl_entry_t entry; errno = 0;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  bool empty = result == -1 && errno == EINVAL; /* Darwin returns 0 when an entry exists. */
  acl_free(acl);
  if (!empty) errno = EPERM;
  return empty;
}
static bool matches(const char *name, uint32_t device, uint64_t inode) {
  for (int i = 0; i < scope_count; i++) {
    const struct scope *scope = &scopes[i];
    if (scope->exists && (uint32_t)scope->device == device && (uint64_t)scope->inode == inode) return true;
    size_t length = strlen(scope->path);
    if (strcmp(name, scope->path) == 0 || (scope->tree && strncmp(name, scope->path, length) == 0 && name[length] == '/')) return true;
  }
  return false;
}
static int read_scopes(int count, char **arguments) {
  if (count < 1 || count > MAX_SCOPES) { errno = EINVAL; return -1; }
  scope_count = count;
  for (int i = 0; i < count; i++) {
    const char *value = arguments[i];
    if ((value[0] != 'f' && value[0] != 'd') || value[1] != ':' || value[2] != '/' || value[3] == '\0'
        || strlen(value + 2) >= MAXPATHLEN) { errno = EINVAL; return -1; }
    scopes[i].path = value + 2; scopes[i].tree = value[0] == 'd';
    struct stat info;
    if (lstat(scopes[i].path, &info) != 0) {
      if (errno == ENOENT) continue;
      return -1;
    }
    if (info.st_uid != getuid() || (info.st_mode & 0022) != 0 || S_ISLNK(info.st_mode)
        || (scopes[i].tree ? (!S_ISDIR(info.st_mode) || (info.st_mode & 0077) != 0) : (!S_ISREG(info.st_mode) || info.st_nlink != 1))) {
      errno = EINVAL; return -1;
    }
    int fd = open(scopes[i].path, O_RDONLY | O_NOFOLLOW | (scopes[i].tree ? O_DIRECTORY : 0));
    if (fd < 0) return -1;
    struct stat current;
    bool valid = owner_only(fd, scopes[i].tree) && fstat(fd, &current) == 0
      && current.st_dev == info.st_dev && current.st_ino == info.st_ino && current.st_nlink == info.st_nlink;
    close(fd);
    if (!valid) { errno = EPERM; return -1; }
    scopes[i].exists = true; scopes[i].device = info.st_dev; scopes[i].inode = info.st_ino;
  }
  return 0;
}
static bool same_process(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_pid == b->pbi_pid && a->pbi_uid == b->pbi_uid
    && a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec;
}
static void emit_handle(pid_t pid, const struct proc_bsdinfo *process, const char *key, int fd, const struct vnode_info_path *vnode) {
  item_start();
  printf("{\"kind\":\"handle\",\"pid\":%d,\"startSeconds\":\"%" PRIu64 "\",\"startMicroseconds\":\"%" PRIu64 "\",\"key\":",
    pid, process->pbi_start_tvsec, process->pbi_start_tvusec);
  json_string(key);
  printf(",\"fd\":%d,\"path\":", fd); json_string(vnode->vip_path);
  printf(",\"device\":\"%" PRIu32 "\",\"inode\":\"%" PRIu64 "\",\"links\":\"%u\"}",
    vnode->vip_vi.vi_stat.vst_dev, vnode->vip_vi.vi_stat.vst_ino, (unsigned int)vnode->vip_vi.vi_stat.vst_nlink);
}
static bool scan_fds(pid_t pid, const struct proc_bsdinfo *process) {
  errno = 0;
  int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (bytes < 0 || (bytes == 0 && errno != 0 && errno != ESRCH)) { unreadable(pid, "fd-list"); return false; }
  if (bytes == 0) return true;
  for (int attempt = 0; attempt < 3; attempt++) {
    size_t capacity = (size_t)bytes + 64 * sizeof(struct proc_fdinfo);
    if (capacity > MAX_FDS * sizeof(struct proc_fdinfo)) { unreadable(pid, "fd-limit"); return false; }
    struct proc_fdinfo *fds = malloc(capacity);
    if (!fds) { unreadable(pid, "allocation"); return false; }
    errno = 0;
    int used = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, (int)capacity);
    if (used < 0 || (used == 0 && errno != 0 && errno != ESRCH)) { free(fds); unreadable(pid, "fd-list"); return false; }
    if ((size_t)used == capacity) { free(fds); bytes = used; continue; }
    if (used % sizeof(struct proc_fdinfo) != 0) { free(fds); unreadable(pid, "fd-size"); return false; }
    for (size_t i = 0; i < (size_t)used / sizeof(struct proc_fdinfo); i++) {
      if (fds[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
      struct vnode_fdinfowithpath info;
      memset(&info, 0, sizeof(info)); errno = 0;
      int got = proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDVNODEPATHINFO, &info, sizeof(info));
      if (got != (int)sizeof(info)) {
        if (errno != EBADF && errno != ENOENT && errno != ESRCH) unreadable(pid, "fd-info");
        continue;
      }
      info.pvip.vip_path[MAXPATHLEN - 1] = '\0';
      if (!matches(info.pvip.vip_path, info.pvip.vip_vi.vi_stat.vst_dev, info.pvip.vip_vi.vi_stat.vst_ino)) continue;
      char key[40]; snprintf(key, sizeof(key), "fd:%d", fds[i].proc_fd);
      emit_handle(pid, process, key, fds[i].proc_fd, &info.pvip);
    }
    free(fds); return true;
  }
  unreadable(pid, "fd-churn"); return false;
}
static bool empty_guard_boundary(const struct proc_regionwithpathinfo *region, uint64_t address) {
  if (region->prp_prinfo.pri_size != 0 || region->prp_prinfo.pri_address <= address) return false;
  /* Only the exact empty, inaccessible guard metadata observed on XNU 12377.161.15.
     This is an unresolved boundary, never an EOF or permission to skip a mapping. */
  struct proc_regionwithpathinfo empty;
  memset(&empty, 0, sizeof(empty));
  empty.prp_prinfo.pri_address = region->prp_prinfo.pri_address;
  empty.prp_prinfo.pri_inheritance = VM_INHERIT_NONE;
  empty.prp_prinfo.pri_user_tag = VM_MEMORY_GUARD;
  empty.prp_prinfo.pri_share_mode = SM_EMPTY;
  return memcmp(region, &empty, sizeof(empty)) == 0;
}
static void scan_mappings(pid_t pid, const struct proc_bsdinfo *process) {
  uint64_t address = 0;
  for (int i = 0; i < MAX_REGIONS; i++) {
    struct proc_regionwithpathinfo region;
    memset(&region, 0, sizeof(region)); errno = 0;
    int bytes = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &region, sizeof(region));
    if (bytes != (int)sizeof(region)) {
      /* XNU proc_pidregionpathinfo returns EINVAL at the end of the address space. */
      if (errno != EINVAL && errno != ESRCH) unreadable(pid, "mapped-file-info");
      return;
    }
    uint64_t begin = region.prp_prinfo.pri_address, size = region.prp_prinfo.pri_size;
    if (size == 0) {
      if (!empty_guard_boundary(&region, address)) { unreadable(pid, "mapped-file-range"); return; }
      const uint64_t boundary = begin;
      memset(&region, 0, sizeof(region)); errno = 0;
      /* Exactly one confirmation at the boundary, without advancing past it. Even EINVAL here is unresolved. */
      bytes = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, boundary, &region, sizeof(region));
      if (bytes != (int)sizeof(region)) { unreadable(pid, "mapped-file-info"); return; }
      begin = region.prp_prinfo.pri_address; size = region.prp_prinfo.pri_size;
      if (begin != boundary) { unreadable(pid, "mapped-file-range"); return; }
    }
    if (size == 0 || begin > UINT64_MAX - size || begin + size <= address) { unreadable(pid, "mapped-file-range"); return; }
    address = begin + size;
    region.prp_vip.vip_path[MAXPATHLEN - 1] = '\0';
    if (!matches(region.prp_vip.vip_path, region.prp_vip.vip_vi.vi_stat.vst_dev, region.prp_vip.vip_vi.vi_stat.vst_ino)) continue;
    char key[80]; snprintf(key, sizeof(key), "map:%" PRIu64 ":%" PRIu64, begin, size);
    emit_handle(pid, process, key, -1, &region.prp_vip);
  }
  unreadable(pid, "mapped-file-limit");
}
static void scan_process(pid_t pid) {
  struct proc_bsdinfo before, after;
  memset(&before, 0, sizeof(before)); errno = 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before)) {
    if (errno != ESRCH) unreadable(pid, "process-identity");
    return;
  }
  if (before.pbi_uid != getuid()) { unreadable(pid, "process-user-changed"); return; }
  scan_fds(pid, &before); scan_mappings(pid, &before);
  memset(&after, 0, sizeof(after)); errno = 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != (int)sizeof(after)) {
    if (errno != ESRCH) unreadable(pid, "process-recheck");
  } else if (!same_process(&before, &after)) unreadable(pid, "process-identity-changed");
}
static int inventory(bool parent_only) {
  printf("{\"version\":1,\"scope\":\"%s\",\"items\":[", parent_only ? "parent" : "current-uid");
  if (parent_only) scan_process(getppid());
  else {
    errno = 0;
    int requested = proc_listpids(PROC_UID_ONLY, (uint32_t)getuid(), NULL, 0);
    if (requested <= 0 || requested > MAX_PROCESSES * (int)sizeof(pid_t)) { errno = EIO; return fail(); }
    bool complete = false;
    for (int attempt = 0; attempt < 3; attempt++) {
      size_t capacity = (size_t)requested + 128 * sizeof(pid_t);
      if (capacity > MAX_PROCESSES * sizeof(pid_t)) { errno = EOVERFLOW; return fail(); }
      pid_t *pids = malloc(capacity);
      if (!pids) return fail();
      int used = proc_listpids(PROC_UID_ONLY, (uint32_t)getuid(), pids, (int)capacity);
      if (used <= 0 || used % sizeof(pid_t) != 0) { free(pids); errno = EIO; return fail(); }
      if ((size_t)used == capacity) { free(pids); requested = used; continue; }
      for (size_t i = 0; i < (size_t)used / sizeof(pid_t); i++) if (pids[i] > 0 && pids[i] != getpid()) scan_process(pids[i]);
      free(pids); complete = true; break;
    }
    if (!complete) { errno = EAGAIN; return fail(); }
  }
  puts("]}"); return 0;
}
static int file_operation(bool flush) {
  /* Only inherited fd 3. Never reopen a pathname or accept an arbitrary fd number. */
  struct stat before, after; struct statfs filesystem;
  if (fstat(3, &before) != 0 || fstatfs(3, &filesystem) != 0) return fail();
  if ((!S_ISREG(before.st_mode) && !S_ISDIR(before.st_mode)) || (S_ISREG(before.st_mode) && before.st_nlink != 1)
      || strcmp(filesystem.f_fstypename, "apfs") != 0 || !(filesystem.f_flags & MNT_LOCAL)) { errno = ENOTSUP; return fail(); }
  if (!owner_only(3, false)) return fail();
  /* No F_BARRIERFSYNC/fsync fallback. A successful Node/libuv sync alone cannot prove this operation. */
  if (flush && fcntl(3, F_FULLFSYNC, 0) != 0) return fail();
  if (fstat(3, &after) != 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_nlink != after.st_nlink) {
    errno = ESTALE; return fail();
  }
  printf("{\"version\":1,\"filesystemType\":\"apfs\",\"local\":true,\"ownershipEnforced\":true,\"acl\":\"none\",\"fullfsync\":%s,\"kind\":\"%s\",\"device\":\"%" PRIu32 "\",\"inode\":\"%" PRIu64 "\"}\n",
    flush ? "true" : "false", S_ISDIR(before.st_mode) ? "directory" : "file", (uint32_t)before.st_dev, (uint64_t)before.st_ino);
  return 0;
}
static int host_identity(void) {
  uuid_t uuid; char value[37]; const struct timespec timeout = { 2, 0 };
  if (gethostuuid(uuid, &timeout) != 0 || uuid_is_null(uuid)) return fail();
  uuid_unparse_lower(uuid, value);
  printf("{\"version\":1,\"hostUuid\":\"%s\"}\n", value); return 0;
}
static int process_identity(const char *value) {
  char *end = NULL; errno = 0; long number = strtol(value, &end, 10);
  if (errno != 0 || !end || *end || number < 1 || number > INT_MAX) { errno = EINVAL; return fail(); }
  pid_t pid = (pid_t)number;
  char boot[64]; size_t length = sizeof(boot);
  if (sysctlbyname("kern.bootsessionuuid", boot, &length, NULL, 0) != 0 || length < 36 || length > sizeof(boot)) return fail();
  boot[sizeof(boot) - 1] = '\0';
  struct proc_bsdinfo info; memset(&info, 0, sizeof(info)); errno = 0;
  int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes != (int)sizeof(info) && errno != ESRCH) return fail();
  if (bytes == (int)sizeof(info) && info.pbi_uid != getuid()) { errno = EPERM; return fail(); }
  printf("{\"version\":1,\"pid\":%d,\"bootSessionUuid\":", pid); json_string(boot);
  if (bytes != (int)sizeof(info)) puts(",\"status\":\"absent\"}");
  else printf(",\"status\":\"present\",\"uid\":%u,\"startSeconds\":\"%" PRIu64 "\",\"startMicroseconds\":\"%" PRIu64 "\"}\n",
    (unsigned int)info.pbi_uid, info.pbi_start_tvsec, info.pbi_start_tvusec);
  return 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "host") == 0) return host_identity();
  if (argc == 2 && strcmp(argv[1], "fullsync") == 0) return file_operation(true);
  if (argc == 2 && strcmp(argv[1], "filesystem") == 0) return file_operation(false);
  if (argc == 3 && strcmp(argv[1], "process") == 0) return process_identity(argv[2]);
  if (argc >= 3 && (strcmp(argv[1], "parent-handles") == 0 || strcmp(argv[1], "source-users") == 0)) {
    if (read_scopes(argc - 2, argv + 2) != 0) return fail();
    return inventory(strcmp(argv[1], "parent-handles") == 0);
  }
  errno = EINVAL; return fail();
}
