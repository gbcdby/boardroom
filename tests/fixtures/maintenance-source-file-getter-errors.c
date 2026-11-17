/* Test-only fixed syscall failures. Linked into a separate temporary addon;
 * never used by the production build or exposed as a caller override. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdarg.h>
#include <stddef.h>
#include <sys/syscall.h>
#include <unistd.h>

long __real_syscall(long number, ...);

int __wrap_ioctl(int fd, unsigned long request, ...) {
  (void)fd; (void)request;
  errno = EACCES;
  return -1;
}

long __wrap_syscall(long number, ...) {
  va_list args;
  va_start(args, number);
  if (number == SYS_openat2) {
    const int fd = va_arg(args, int);
    const char *name = va_arg(args, const char *);
    const struct open_how *how = va_arg(args, const struct open_how *);
    const size_t size = va_arg(args, size_t);
    va_end(args);
    return __real_syscall(number, fd, name, how, size);
  }
  va_end(args);
  errno = number == SYS_name_to_handle_at ? EOVERFLOW : ENOSYS;
  return -1;
}
