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

long __real_syscall(long number, ...);
#if defined(P3_TEST_CONTENT_OPEN_FAILURE) || defined(P3_TEST_CONTENT_CLOSE_FAILURE) || \
    defined(P3_TEST_PSEUDO_CLOSE_FAILURE) || defined(P3_TEST_SHORT_READS) || \
    defined(P3_TEST_NO_EOF) || defined(P3_TEST_SOURCE_CHANGE) || defined(P3_TEST_BYTE_BUDGET) || \
    defined(P3_TEST_DIRECTORY_CLOSE_FAILURE)
#define P3_TEST_FORWARD_GETTERS 1
int __real_ioctl(int fd, unsigned long request, ...);
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
