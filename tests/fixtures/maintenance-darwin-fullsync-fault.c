/* Test-only syscall fault. A normal fsync remains available; F_FULLFSYNC/barrier fail. */
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <errno.h>
#include <unistd.h>

static int reject_fullsync(int fd, int command, ...) {
  if (command == F_FULLFSYNC || command == F_BARRIERFSYNC) {
    static const char marker[] = "injected_fullfsync_failure\n";
    (void)write(STDERR_FILENO, marker, sizeof(marker) - 1);
    errno = ENOTSUP; return -1;
  }
  va_list arguments; va_start(arguments, command); uintptr_t value = va_arg(arguments, uintptr_t); va_end(arguments);
  return fcntl(fd, command, value);
}
__attribute__((used)) static struct { const void *replacement; const void *original; } interpose
  __attribute__((section("__DATA,__interpose"))) = { (const void *)(uintptr_t)&reject_fullsync, (const void *)(uintptr_t)&fcntl };
