#define _GNU_SOURCE
/* Exec this gate first. The original Popen must return and retain a pidfd
 * before its one-byte acknowledgement permits the fixed executable. */
#include <errno.h>
#include <fcntl.h>
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

int main(int argc, char **argv) {
    /* This target is compiled into the same fixed gate for the one non-VM
     * ownership witness. It cannot execute a caller-supplied command. */
    if (argc == 4 && !strcmp(argv[1], "witness-target")) {
        int parent = number(argv[2]), status = number(argv[3]), death = 0;
        if (prctl(PR_GET_PDEATHSIG, &death) || death != SIGKILL || getppid() != parent) return failed(status, "witness-parent");
        if (dprintf(status, "WITNESS_EXEC %d %d %d\n", getpid(), getppid(), death) < 0) return 74;
        for (;;) pause();
    }
    if (argc < 8 || (strcmp(argv[1], "qemu") && strcmp(argv[1], "witness"))) return 64;
    int parent = number(argv[2]), ack = number(argv[3]), status = number(argv[4]), executable = number(argv[5]);
    int own_executable = number(argv[6]);
    if (parent < 1 || ack < 3 || status < 3 || executable < 3 || own_executable < 3 || ack == status || ack == executable || status == executable || own_executable == executable || own_executable == status || own_executable == ack) return 64;
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) return failed(status, "parent-before-gate");
    if (close(own_executable)) return failed(status, "gate-file-close");
    struct stat st;
    if (fstat(executable, &st) || !S_ISREG(st.st_mode) || (st.st_mode & (S_ISUID | S_ISGID))) { errno = EINVAL; return failed(status, "executable"); }
    if (lower(RLIMIT_AS, 2147483648ULL) || lower(RLIMIT_CPU, 300) || lower(RLIMIT_CORE, 0)) return failed(status, "child-limits");
    if (dprintf(status, "GATE_READY %d %d\n", getpid(), getppid()) < 0) return 74;
    char byte;
    ssize_t n = read(ack, &byte, 1);
    if (n != 1 || byte != 'G') { if (n >= 0) errno = EPROTO; return failed(status, "ack"); }
    if (close(ack)) return failed(status, "ack-close");
    if (getppid() != parent) { errno = ECHILD; return failed(status, "parent-after-gate"); }
    if (fcntl(executable, F_SETFD, FD_CLOEXEC)) return failed(status, "executable-cloexec");
    if (!strcmp(argv[1], "witness")) {
        if (argc != 8) return 64;
        char parent_arg[24], status_arg[24];
        snprintf(parent_arg, sizeof(parent_arg), "%d", parent);
        snprintf(status_arg, sizeof(status_arg), "%d", status);
        char *args[] = {argv[7], "witness-target", parent_arg, status_arg, NULL};
        fexecve(executable, args, environ);
    } else {
        if (fcntl(status, F_SETFD, FD_CLOEXEC)) return failed(status, "status-cloexec");
        fexecve(executable, &argv[7], environ);
    }
    return failed(status, "exec");
}
