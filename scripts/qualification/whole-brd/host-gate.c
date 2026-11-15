#define _GNU_SOURCE
/* Exec this gate first. The original Popen must return and retain a pidfd
 * before its one-byte acknowledgement permits the fixed executable. */
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int number(const char *s) {
    char *end = NULL; errno = 0; long v = strtol(s, &end, 10);
    if (errno || !*s || *end || v < 0 || v > 2147483647L) _exit(64);
    return (int)v;
}

static int failed(int fd, const char *stage) {
    int original = errno;
    dprintf(fd, "ERROR %s %d\n", stage, original);
    return 71;
}

static int lower(int which, rlim_t value) {
    struct rlimit current;
    if (getrlimit(which, &current)) return -1;
    if ((current.rlim_max != RLIM_INFINITY && current.rlim_max < value) ||
        (current.rlim_cur != RLIM_INFINITY && current.rlim_cur < value)) { errno = ERANGE; return -1; }
    struct rlimit fixed = {value, value};
    return setrlimit(which, &fixed);
}

static uintmax_t identifier(const char *s) {
    char *end = NULL; errno = 0;
    if (!*s || *s == '-' || *s == '+') _exit(64);
    uintmax_t value = strtoumax(s, &end, 10);
    if (errno || *end) _exit(64);
    return value;
}

static int serial_identity(int fd, uintmax_t device, uintmax_t inode) {
    struct stat st;
    if (fstat(fd, &st)) return -1;
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0) return -1;
    if (!S_ISFIFO(st.st_mode) || (flags & O_ACCMODE) != O_WRONLY ||
        (uintmax_t)st.st_dev != device || (uintmax_t)st.st_ino != inode) {
        errno = EINVAL; return -1;
    }
    return 0;
}

static int fixed_line(const char *expected) {
    char line[256]; size_t length = 0;
    while (length < sizeof(line) - 1) {
        ssize_t n = read(STDIN_FILENO, line + length, 1);
        if (n != 1) return -1;
        if (line[length++] == '\n') {
            line[length] = 0; return strcmp(line, expected) ? -1 : 0;
        }
    }
    return -1;
}

int main(int argc, char **argv) {
    /* One non-VM, non-socket witness of this exact gate's new inherited pipe.
     * It accepts only two fixed stdio messages, never an external program. */
    if (argc == 7 && !strcmp(argv[1], "pipe-witness-target")) {
        int parent = number(argv[2]), status = number(argv[3]), serial = number(argv[4]), death = 0;
        uintmax_t device = identifier(argv[5]), inode = identifier(argv[6]);
        if (prctl(PR_GET_PDEATHSIG, &death) || death != SIGKILL || getppid() != parent ||
            serial_identity(serial, device, inode)) return failed(status, "pipe-witness-identity");
        if (dprintf(status, "PIPE_WITNESS_EXEC %d %d %d %d %ju %ju\n", getpid(), getppid(), death, serial, device, inode) < 0) return 74;
        if (dprintf(STDERR_FILENO, "PIPE_WITNESS_STDERR\n") < 0 ||
            dprintf(serial, "PIPE_WITNESS_SERIAL\n") < 0 ||
            dprintf(STDOUT_FILENO, "{\"QMP\":{\"witness\":true}}\r\n") < 0) return 74;
        if (fixed_line("{\"execute\": \"qmp_capabilities\", \"id\": \"capabilities\"}\n")) return 65;
        if (dprintf(STDOUT_FILENO, "{\"return\":{},\"id\":\"capabilities\"}\r\n") < 0) return 74;
        if (fixed_line("{\"execute\": \"quit\", \"id\": \"quit\"}\n")) return 65;
        if (dprintf(STDOUT_FILENO, "{\"return\":{},\"id\":\"quit\"}\r\n") < 0) return 74;
        /* Keep the serial writer until exit, as the fdset can do in QEMU. */
        return 0;
    }
    /* This target is compiled into the same fixed gate for the one non-VM
     * ownership witness. It cannot execute a caller-supplied command. */
    if (argc == 4 && !strcmp(argv[1], "witness-target")) {
        int parent = number(argv[2]), status = number(argv[3]), death = 0;
        if (prctl(PR_GET_PDEATHSIG, &death) || death != SIGKILL || getppid() != parent) return failed(status, "witness-parent");
        if (dprintf(status, "WITNESS_EXEC %d %d %d\n", getpid(), getppid(), death) < 0) return 74;
        for (;;) pause();
    }
    if (argc < 11 || (strcmp(argv[1], "qemu") && strcmp(argv[1], "witness") && strcmp(argv[1], "pipe-witness"))) return 64;
    int parent = number(argv[2]), ack = number(argv[3]), status = number(argv[4]), executable = number(argv[5]);
    int own_executable = number(argv[6]);
    int serial = number(argv[7]);
    uintmax_t device = identifier(argv[8]), inode = identifier(argv[9]);
    if (parent < 1 || ack < 3 || status < 3 || executable < 3 || own_executable < 3 || ack == status || ack == executable || status == executable || own_executable == executable || own_executable == status || own_executable == ack) return 64;
    if (serial < 3 || serial == ack || serial == status || serial == executable || serial == own_executable) return 64;
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) return failed(status, "parent-before-gate");
    if (close(own_executable)) return failed(status, "gate-file-close");
    struct stat st;
    if (fstat(executable, &st) || !S_ISREG(st.st_mode) || (st.st_mode & (S_ISUID | S_ISGID))) { errno = EINVAL; return failed(status, "executable"); }
    if (serial_identity(serial, device, inode)) return failed(status, "serial-identity");
    if (fcntl(serial, F_SETFD, 0)) return failed(status, "serial-inherit");
    if (lower(RLIMIT_AS, 2147483648ULL) || lower(RLIMIT_CPU, 300) || lower(RLIMIT_CORE, 0)) return failed(status, "child-limits");
    if (dprintf(status, "GATE_READY %d %d SERIAL %d %ju %ju\n", getpid(), getppid(), serial, device, inode) < 0) return 74;
    char byte;
    ssize_t n = read(ack, &byte, 1);
    if (n != 1 || byte != 'G') { if (n >= 0) errno = EPROTO; return failed(status, "ack"); }
    if (close(ack)) return failed(status, "ack-close");
    if (getppid() != parent) { errno = ECHILD; return failed(status, "parent-after-gate"); }
    if (fcntl(executable, F_SETFD, FD_CLOEXEC)) return failed(status, "executable-cloexec");
    if (!strcmp(argv[1], "witness")) {
        if (argc != 11) return 64;
        char parent_arg[24], status_arg[24];
        snprintf(parent_arg, sizeof(parent_arg), "%d", parent);
        snprintf(status_arg, sizeof(status_arg), "%d", status);
        char *args[] = {argv[10], "witness-target", parent_arg, status_arg, NULL};
        fexecve(executable, args, environ);
    } else if (!strcmp(argv[1], "pipe-witness")) {
        if (argc != 11) return 64;
        char *args[] = {argv[10], "pipe-witness-target", argv[2], argv[4], argv[7], argv[8], argv[9], NULL};
        fexecve(executable, args, environ);
    } else {
        if (fcntl(status, F_SETFD, FD_CLOEXEC)) return failed(status, "status-cloexec");
        fexecve(executable, &argv[10], environ);
    }
    return failed(status, "exec");
}
