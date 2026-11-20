/* Test-only fixed syscall failures. Linked into a separate temporary addon;
 * never used by the production build or exposed as a caller override. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <linux/magic.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <string.h>
#include <dirent.h>
#include <stdio.h>

long __real_syscall(long number, ...);
#if defined(P3_TEST_CONTENT_OPEN_FAILURE) || defined(P3_TEST_CONTENT_CLOSE_FAILURE) || \
    defined(P3_TEST_PSEUDO_CLOSE_FAILURE) || defined(P3_TEST_SHORT_READS) || \
    defined(P3_TEST_NO_EOF) || defined(P3_TEST_SOURCE_CHANGE) || defined(P3_TEST_BYTE_BUDGET) || \
    defined(P3_TEST_DIRECTORY_CLOSE_FAILURE) || defined(P3_TEST_BLOCK_READERS)
#define P3_TEST_FORWARD_GETTERS 1
int __real_ioctl(int fd, unsigned long request, ...);
#endif

#ifdef P3_TEST_BLOCK_READERS
/* A compile-time isolated pseudo-sysfs tree of owned ordinary files. The
 * fixture changes only the sysfs magic and resolved path observations; read,
 * EOF, fstat identities, opens and closes act on those real files. This is
 * never a real sysfs/driver/qualification positive. No runtime override is
 * present in the production addon. */
static struct { int fd, kind; } block_owned[64];
static size_t block_owned_count;
static unsigned block_size_opens, block_disk_opens;
static bool block_fault_applied;
#ifdef P3_TEST_MB_READERS
/* Additional fixed test-only mapping: the actual /proc anchor retains real
 * process observations; only its exact ext4 directory is mapped to owned
 * ordinary files. Source filesystem and that mapped directory's magic are
 * modeled. No value here is an actual ext4 qualification observation. */
static bool mb_fault_applied;
static unsigned mb_summary_opens;
static bool mb_source_fd(int fd) {
  char link[64], target[4096];
  snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
  ssize_t size = readlink(link, target, sizeof(target) - 1);
  if (size < 0) return false;
  target[size] = 0;
  const size_t root_size = strlen(P3_TEST_MB_SOURCE_ROOT);
  return !strncmp(target, P3_TEST_MB_SOURCE_ROOT, root_size) &&
    (target[root_size] == 0 || target[root_size] == '/');
}
#endif
static int block_kind(int fd) {
  for (size_t i = 0; i < block_owned_count; i++) if (block_owned[i].fd == fd) return block_owned[i].kind;
  return 0;
}
static int block_track(int fd, int kind) {
  if (fd < 0) return fd;
  if (block_owned_count == 64) { close(fd); errno = EMFILE; return -1; }
  block_owned[block_owned_count].fd = fd; block_owned[block_owned_count++].kind = kind; return fd;
}
static void block_forget(int fd) {
  for (size_t i = 0; i < block_owned_count; i++) if (block_owned[i].fd == fd) {
    block_owned[i] = block_owned[--block_owned_count]; return;
  }
}
int __real_close(int fd);
#if defined(P3_TEST_BLOCK_RAW_CHANGE) || defined(P3_TEST_BLOCK_IDENTITY_CHANGE) || defined(P3_TEST_BLOCK_APPEAR) || defined(P3_TEST_BLOCK_BAD_CHANGE)
static int block_write(const char *name, const char *bytes) {
  char target[4096]; snprintf(target, sizeof(target), "%s/devices/m04-test-node/%s", P3_TEST_BLOCK_ROOT, name);
  int fd = open(target, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  const size_t size = strlen(bytes); const ssize_t wrote = write(fd, bytes, size); const int rc = __real_close(fd);
  if (wrote != (ssize_t)size || rc) { errno = EIO; return -1; }
  return 0;
}
#endif
int __real_fstatfs(int fd, struct statfs *value);
int __wrap_fstatfs(int fd, struct statfs *value) {
  const int rc = __real_fstatfs(fd, value);
  if (!rc && block_kind(fd)) value->f_type = SYSFS_MAGIC;
#ifdef P3_TEST_MB_READERS
  if (!rc && block_kind(fd) >= 7) value->f_type = PROC_SUPER_MAGIC;
  if (!rc && mb_source_fd(fd)) value->f_type = EXT4_SUPER_MAGIC;
#endif
  return rc;
}
#ifdef P3_TEST_MB_READERS
int __real_fstatat(int fd, const char *name, struct stat *value, int flags);
int __wrap_fstatat(int fd, const char *name, struct stat *value, int flags) {
  if (block_kind(fd) == 7 && !strcmp(name, "fs/ext4/m04-test-node")) {
#ifdef P3_TEST_MB_PROC_UNAVAILABLE
    errno = EACCES; return -1;
#else
    return __real_fstatat(AT_FDCWD, P3_TEST_MB_PROC_ROOT, value, flags);
#endif
  }
  return __real_fstatat(fd, name, value, flags);
}
#endif
ssize_t __real_readlinkat(int fd, const char *name, char *buffer, size_t size);
ssize_t __wrap_readlinkat(int fd, const char *name, char *buffer, size_t size) {
  int target = -1; char extra;
  if (sscanf(name, "self/fd/%d%c", &target, &extra) == 1 && block_kind(target) == 2) {
    const char *resolved = "/sys/devices/m04-test-node"; size_t length = strlen(resolved);
    if (length > size) length = size;
    memcpy(buffer, resolved, length); return (ssize_t)length;
  }
  return __real_readlinkat(fd, name, buffer, size);
}
ssize_t __real_read(int fd, void *buffer, size_t size);
ssize_t __wrap_read(int fd, void *buffer, size_t size) {
#ifdef P3_TEST_MB_READERS
  if (block_kind(fd) == 9 && size) {
#ifdef P3_TEST_MB_BUDGET
    size = 1;
#elif !defined(P3_TEST_MB_LIMIT) && !defined(P3_TEST_MB_OVERSIZED)
    if (size > 17) size = 17;
#endif
    return __real_read(fd, buffer, size);
  }
#endif
  // Short reads are real reads of the same original leaf, never invented bytes.
  return __real_read(fd, buffer, block_kind(fd) == 3 && size ? 1 : size);
}
#ifdef __GLIBC__
ssize_t __real___read_chk(int fd, void *buffer, size_t size, size_t capacity);
ssize_t __wrap___read_chk(int fd, void *buffer, size_t size, size_t capacity) {
  if (size > capacity) return __real___read_chk(fd, buffer, size, capacity);
  return __wrap_read(fd, buffer, size);
}
#endif
int __wrap_close(int fd) {
  const int kind = block_kind(fd), rc = __real_close(fd);
  if (rc) return rc;
  block_forget(fd);
#ifdef P3_TEST_MB_READERS
  if (kind == 9 && !mb_fault_applied) {
#if defined(P3_TEST_MB_CLOSE_FAILURE)
    mb_fault_applied = true; errno = EIO; return -1;
#elif defined(P3_TEST_MB_RAW_CHANGE) || defined(P3_TEST_MB_BAD_CHANGE)
    mb_fault_applied = true;
    int output = open(P3_TEST_MB_PROC_ROOT "/mb_structs_summary", O_WRONLY | O_CLOEXEC);
    if (output < 0) return -1;
    ssize_t wrote = pwrite(output,
#ifdef P3_TEST_MB_BAD_CHANGE
      "2",
#else
      "1",
#endif
      1, 15);
    int closed = __real_close(output);
    if (wrote != 1 || closed) { errno = EIO; return -1; }
#elif defined(P3_TEST_MB_IDENTITY_CHANGE)
    mb_fault_applied = true;
    if (rename(P3_TEST_MB_PROC_ROOT "/mb_structs_summary", P3_TEST_MB_PROC_ROOT "/retained-summary")) return -1;
    int input = open(P3_TEST_MB_PROC_ROOT "/retained-summary", O_RDONLY | O_CLOEXEC);
    if (input < 0) return -1;
    char bytes[16385]; ssize_t size = __real_read(input, bytes, sizeof(bytes)); int closed = __real_close(input);
    if (size < 0 || closed) { errno = EIO; return -1; }
    int output = open(P3_TEST_MB_PROC_ROOT "/mb_structs_summary", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (output < 0) return -1;
    ssize_t wrote = write(output, bytes, (size_t)size); closed = __real_close(output);
    if (wrote != size || closed) { errno = EIO; return -1; }
#elif defined(P3_TEST_MB_DISAPPEAR)
    mb_fault_applied = true;
    return unlink(P3_TEST_MB_PROC_ROOT "/mb_structs_summary");
#elif defined(P3_TEST_MB_PROC_CHANGE)
    mb_fault_applied = true;
    if (rename(P3_TEST_MB_PROC_ROOT, P3_TEST_MB_PROC_ROOT "-retained")) return -1;
    return mkdir(P3_TEST_MB_PROC_ROOT, 0700);
#endif
  }
#endif
  if (block_fault_applied) return rc;
#if defined(P3_TEST_BLOCK_CLOSE_FAILURE)
  if (kind == 3) { block_fault_applied = true; errno = EIO; return -1; }
#elif defined(P3_TEST_BLOCK_RAW_CHANGE) || defined(P3_TEST_BLOCK_BAD_CHANGE)
  if (kind == 3) {
    block_fault_applied = true;
    return block_write("size",
#ifdef P3_TEST_BLOCK_BAD_CHANGE
      "01\n"
#else
      "2\n"
#endif
    );
  }
#elif defined(P3_TEST_BLOCK_IDENTITY_CHANGE)
  if (kind == 3) {
    block_fault_applied = true;
    if (rename(P3_TEST_BLOCK_ROOT "/devices/m04-test-node/size", P3_TEST_BLOCK_ROOT "/retained-size")) return -1;
    return block_write("size", "18446744073709551615\n");
  }
#elif defined(P3_TEST_BLOCK_DISAPPEAR)
  if (kind == 5) {
    block_fault_applied = true;
    return unlink(P3_TEST_BLOCK_ROOT "/devices/m04-test-node/diskseq");
  }
#else
  (void)kind;
#endif
  return rc;
}
static int block_open(long number, int base, const char *name, const struct open_how *how, size_t size) {
  if (base == AT_FDCWD && !strcmp(name, "/sys"))
    return block_track((int)__real_syscall(number, base, P3_TEST_BLOCK_ROOT, how, size), 1);
  const int parent = block_kind(base);
#ifdef P3_TEST_MB_READERS
  if (base == AT_FDCWD && !strcmp(name, "/proc"))
    return block_track((int)__real_syscall(number, base, name, how, size), 7);
  if (parent == 7) {
    if (!strcmp(name, "fs/ext4/m04-test-node")) {
      struct open_how fixed = *how;
      fixed.resolve &= ~(RESOLVE_BENEATH | RESOLVE_NO_XDEV);
      return block_track((int)__real_syscall(number, AT_FDCWD, P3_TEST_MB_PROC_ROOT, &fixed, size), 8);
    }
    return (int)__real_syscall(number, base, name, how, size);
  }
  if (parent == 8) {
    const bool summary = !strcmp(name, "mb_structs_summary");
    if (summary) mb_summary_opens++;
    int fd = (int)__real_syscall(number, base, name, how, size), error = errno;
#ifdef P3_TEST_MB_APPEAR
    if (summary && mb_summary_opens == 1 && fd < 0 && error == ENOENT) {
      if (rename(P3_TEST_MB_PROC_ROOT "/available-summary", P3_TEST_MB_PROC_ROOT "/mb_structs_summary")) return -1;
    }
#endif
    errno = error;
    return block_track(fd, summary ? 9 : 10);
  }
#endif
  int kind = 6;
  if (parent == 1 && !strncmp(name, "dev/block/", 10)) kind = 2;
  if (parent == 2 && !strcmp(name, "size")) { kind = 3; block_size_opens++; }
  if (parent == 2 && !strcmp(name, "ro")) kind = 4;
  if (parent == 2 && !strcmp(name, "diskseq")) { kind = 5; block_disk_opens++; }
  const int fd = (int)__real_syscall(number, base, name, how, size), error = errno;
#ifdef P3_TEST_BLOCK_APPEAR
  if (kind == 5 && block_disk_opens == 1 && fd < 0 && error == ENOENT) {
    if (block_write("diskseq", "0\n")) return -1;
  }
#endif
  errno = error;
  return parent ? block_track(fd, kind) : fd;
}
#endif

#ifdef P3_TEST_DIRECTORY_CLOSE_FAILURE
int __real_closedir(DIR *stream);
int __wrap_closedir(DIR *stream) {
  int rc = __real_closedir(stream);
  if (rc) return rc;
  errno = EIO; return -1;
}
#endif

#ifdef P3_TEST_BYTE_BUDGET
/* A fixed negative-only pseudo-source substitute. Both files deliberately
 * never reach EOF, so no fact from it can be observed or qualify a source.
 * It exercises the aggregate limit even on hosts without mounted sysfs. */
static int fixture_sysfs_fd = -1, fixture_notes_fd = -1;
int __real_fstatfs(int fd, struct statfs *value);
int __wrap_fstatfs(int fd, struct statfs *value) {
  int rc = __real_fstatfs(fd, value);
  if (!rc && (fd == fixture_sysfs_fd || fd == fixture_notes_fd)) value->f_type = SYSFS_MAGIC;
  return rc;
}
int __real_close(int fd);
int __wrap_close(int fd) {
  int rc = __real_close(fd);
  if (!rc && fd == fixture_sysfs_fd) fixture_sysfs_fd = -1;
  if (!rc && fd == fixture_notes_fd) fixture_notes_fd = -1;
  return rc;
}
#endif

int __wrap_ioctl(int fd, unsigned long request, ...) {
#ifdef P3_TEST_FORWARD_GETTERS
  va_list args; va_start(args, request);
  void *value = va_arg(args, void *); va_end(args);
  return __real_ioctl(fd, request, value);
#else
  (void)fd; (void)request;
  errno = EACCES;
  return -1;
#endif
}

#if defined(P3_TEST_CONTENT_CLOSE_FAILURE) || defined(P3_TEST_PSEUDO_CLOSE_FAILURE)
int __real_close(int fd);
int __wrap_close(int fd) {
  static int failed;
  struct stat st;
  int flags = fcntl(fd, F_GETFL);
  bool selected = false;
#ifdef P3_TEST_PSEUDO_CLOSE_FAILURE
  struct statfs fs;
  selected = fstatfs(fd, &fs) == 0 && (fs.f_type == PROC_SUPER_MAGIC || fs.f_type == SYSFS_MAGIC);
#else
  selected = true;
#endif
  if (!failed && selected && flags >= 0 && !(flags & O_PATH) && fstat(fd, &st) == 0 && S_ISREG(st.st_mode)) {
    failed = 1;
    int rc = __real_close(fd);
    if (rc != 0) return rc;
    /* Real close completed, but its reported result is unknown to the caller.
     * A second close of this integer could close a later unrelated owner. */
    errno = EIO; return -1;
  }
  return __real_close(fd);
}
#endif

#if defined(P3_TEST_SHORT_READS) || defined(P3_TEST_NO_EOF) || defined(P3_TEST_SOURCE_CHANGE) || defined(P3_TEST_BYTE_BUDGET)
ssize_t __real_read(int fd, void *buffer, size_t size);
#ifdef P3_TEST_SOURCE_CHANGE
static int source_observation_started;
int __real_fstat(int fd, struct stat *value);
int __wrap_fstat(int fd, struct stat *value) {
  int rc = __real_fstat(fd, value);
  int flags = fcntl(fd, F_GETFL);
  if (!rc && source_observation_started && flags >= 0 && (flags & O_NOATIME) && !(flags & O_PATH)) value->st_size++;
  return rc;
}
#endif
ssize_t __wrap_read(int fd, void *buffer, size_t size) {
#ifdef P3_TEST_SOURCE_CHANGE
  source_observation_started = 1;
#endif
#ifdef P3_TEST_SHORT_READS
  return __real_read(fd, buffer, size ? 1 : 0);
#elif defined(P3_TEST_NO_EOF) || defined(P3_TEST_BYTE_BUDGET)
  (void)fd; memset(buffer, 'x', size); return (ssize_t)size;
#else
  return __real_read(fd, buffer, size);
#endif
}
#ifdef __GLIBC__
/* Fortified collectors may call __read_chk instead of read. The isolated
 * addon must wrap both symbols so the fixed fault still reaches that call.
 * Preserve the original bounds failure before applying any short-read or
 * synthetic-byte behavior; this is not an unchecked fortified-read alias. */
ssize_t __real___read_chk(int fd, void *buffer, size_t size, size_t capacity);
ssize_t __wrap___read_chk(int fd, void *buffer, size_t size, size_t capacity) {
  if (size > capacity) return __real___read_chk(fd, buffer, size, capacity);
  return __wrap_read(fd, buffer, size);
}
#endif
#endif

#ifdef P3_TEST_CHILD_IDENTITY_FAILURE
int __real_fstat(int fd, struct stat *value);
int __wrap_fstat(int fd, struct stat *value) {
  const int rc = __real_fstat(fd, value), flags = fcntl(fd, F_GETFL);
  if (!rc && flags >= 0 && (flags & O_NOATIME) && S_ISREG(value->st_mode)) value->st_nlink = 2;
  return rc;
}
#endif

long __wrap_syscall(long number, ...) {
  va_list args;
  va_start(args, number);
  if (number == SYS_openat2) {
    const int fd = va_arg(args, int);
    const char *name = va_arg(args, const char *);
    const struct open_how *how = va_arg(args, const struct open_how *);
    const size_t size = va_arg(args, size_t);
    va_end(args);
#ifdef P3_TEST_BLOCK_READERS
    return block_open(number, fd, name, how, size);
#endif
#ifdef P3_TEST_CONTENT_OPEN_FAILURE
    if ((how->flags & O_NOATIME) && !(how->flags & O_PATH) && !(how->flags & O_DIRECTORY)) { errno = EOWNERDEAD; return -1; }
#endif
#ifdef P3_TEST_BYTE_BUDGET
    if (fd == AT_FDCWD && !strcmp(name, "/sys")) {
      fixture_sysfs_fd = (int)__real_syscall(number, fd, "/proc", how, size); return fixture_sysfs_fd;
    }
    if (fd == fixture_sysfs_fd && !strcmp(name, "kernel/notes")) {
      fixture_notes_fd = (int)__real_syscall(number, fd, "version", how, size); return fixture_notes_fd;
    }
#endif
    return __real_syscall(number, fd, name, how, size);
  }
#ifdef P3_TEST_FORWARD_GETTERS
  if (number == SYS_statx) {
    const int fd = va_arg(args, int); const char *name = va_arg(args, const char *);
    const int flags = va_arg(args, int); const unsigned int mask = va_arg(args, unsigned int);
    void *value = va_arg(args, void *); va_end(args);
    return __real_syscall(number, fd, name, flags, mask, value);
  }
  if (number == SYS_name_to_handle_at) {
    const int fd = va_arg(args, int); const char *name = va_arg(args, const char *);
    void *handle = va_arg(args, void *), *mount = va_arg(args, void *);
    const int flags = va_arg(args, int); va_end(args);
    return __real_syscall(number, fd, name, handle, mount, flags);
  }
#ifdef SYS_statmount
  if (number == SYS_statmount) {
    void *request = va_arg(args, void *), *result = va_arg(args, void *);
    const size_t size = va_arg(args, size_t); const unsigned int flags = va_arg(args, unsigned int); va_end(args);
#ifdef P3_TEST_BYTE_BUDGET
    (void)request; (void)result; (void)size; (void)flags; errno = ENOSYS; return -1;
#else
    return __real_syscall(number, request, result, size, flags);
#endif
  }
#endif
  if (number == SYS_gettid) { va_end(args); return __real_syscall(number); }
#ifdef SYS_getdents64
  if (number == SYS_getdents64) {
    const int fd = va_arg(args, int); void *buffer = va_arg(args, void *);
    const size_t size = va_arg(args, size_t); va_end(args);
    return __real_syscall(number, fd, buffer, size);
  }
#endif
#ifdef SYS_ioprio_get
  if (number == SYS_ioprio_get) {
    const int which = va_arg(args, int), who = va_arg(args, int); va_end(args);
    return __real_syscall(number, which, who);
  }
#endif
#endif
  va_end(args);
  errno = number == SYS_name_to_handle_at ? EOVERFLOW : ENOSYS;
  return -1;
}
