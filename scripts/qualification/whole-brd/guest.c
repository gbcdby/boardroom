#define _GNU_SOURCE
/* Private guest-only bootstrap/collector. Never a production provider. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static unsigned char bytes[1024 * 1024 + 2];
static char run_id[37];
static unsigned sequence;
static bool all_ok = true;

struct observation { size_t length; int error, close_error; bool eof; };

static int management_fail(const char *step, int error) {
    fprintf(stderr, "BRDF1 {\"run_id\":\"%s\",\"origin\":\"management\","
            "\"event\":\"bootstrap-error\",\"step\":\"%s\",\"errno\":%d}\n",
            run_id, step, error);
    fflush(stderr);
    return 71;
}

static struct observation read_file(const char *path, size_t limit) {
    struct observation o = {0};
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) { o.error = errno; return o; }
    while (o.length <= limit) {
        ssize_t n = read(fd, bytes + o.length, limit + 1 - o.length);
        if (n < 0) { o.error = errno; break; }
        if (!n) { o.eof = true; break; }
        o.length += (size_t)n;
        if (o.length > limit) { o.error = EFBIG; break; }
    }
    if (close(fd)) o.close_error = errno;
    bytes[o.length] = 0;
    return o;
}

static bool emit(const char *item, const char *path, struct observation o, bool absent) {
    bool ok = !o.close_error && o.eof && (!o.error || (absent && o.error == ENOENT));
    if (!ok) all_ok = false;
    printf("BRDF1 {\"run_id\":\"%s\",\"origin\":\"ordinary\",\"seq\":%u,"
           "\"item\":\"%s\",\"path\":\"%s\",\"status\":\"%s\",\"errno\":%d,"
           "\"eof\":%s,\"close_errno\":%d,\"bytes\":%zu,\"data_hex\":\"",
           run_id, ++sequence, item, path, ok ? (absent ? "ABSENT" : "OK") : "ERROR",
           o.error, o.eof ? "true" : "false", o.close_error, o.length);
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < o.length; ++i) {
        putchar(hex[bytes[i] >> 4]); putchar(hex[bytes[i] & 15]);
    }
    puts("\"}");
    if (fflush(stdout) || ferror(stdout)) _exit(74);
    return ok;
}

static bool field(const char *key, char *out, size_t capacity, size_t length) {
    size_t key_length = strlen(key), count = 0;
    for (size_t off = 0; off < length;) {
        unsigned char *nl = memchr(bytes + off, '\n', length - off);
        size_t end = nl ? (size_t)(nl - bytes) : length;
        if (end - off > key_length && !memcmp(bytes + off, key, key_length) && bytes[off + key_length] == ':') {
            size_t start = off + key_length + 1;
            while (start < end && (bytes[start] == ' ' || bytes[start] == '\t')) ++start;
            while (end > start && (bytes[end - 1] == ' ' || bytes[end - 1] == '\t')) --end;
            if (++count != 1 || end - start >= capacity) return false;
            memcpy(out, bytes + start, end - start); out[end - start] = 0;
        }
        off = nl ? (size_t)(nl - bytes) + 1 : length;
    }
    return count == 1;
}

static bool ordinary_status(size_t length) {
    char value[256], extra;
    unsigned a, b, c, d;
    const char *ids[] = {"Uid", "Gid"};
    for (size_t i = 0; i < 2; ++i) {
        if (!field(ids[i], value, sizeof(value), length) ||
            sscanf(value, "%u %u %u %u %c", &a, &b, &c, &d, &extra) != 4 ||
            a != 1000 || b != 1000 || c != 1000 || d != 1000) return false;
    }
    if (!field("Groups", value, sizeof(value), length) || value[0]) return false;
    if (!field("NoNewPrivs", value, sizeof(value), length) || strcmp(value, "1")) return false;
    const char *caps[] = {"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"};
    for (size_t i = 0; i < 5; ++i)
        if (!field(caps[i], value, sizeof(value), length) || strcmp(value, "0000000000000000")) return false;
    return getuid() == 1000 && geteuid() == 1000 && getgid() == 1000 && getegid() == 1000 && getppid() == 1;
}

static void file_record(const char *item, const char *path, size_t limit) {
    struct observation o = read_file(path, limit);
    emit(item, path, o, false);
}

static void link_record(const char *item, const char *path) {
    struct observation o = {0};
    ssize_t n = readlink(path, (char *)bytes, 1025);
    if (n < 0) o.error = errno;
    else { o.length = (size_t)n; o.eof = n <= 1024; if (!o.eof) o.error = EFBIG; }
    emit(item, path, o, false);
}

static int collect(void) {
    struct observation o = read_file("/proc/self/status", 64 * 1024);
    bool identity = !o.error && !o.close_error && o.eof && ordinary_status(o.length);
    emit("status_before", "/proc/self/status", o, false);
    if (!identity) return 77;
    file_record("self_stat", "/proc/self/stat", 8 * 1024);
    file_record("uid_map", "/proc/self/uid_map", 4096);
    file_record("gid_map", "/proc/self/gid_map", 4096);
    link_record("ns_pid", "/proc/self/ns/pid");
    link_record("ns_user", "/proc/self/ns/user");
    link_record("ns_mnt", "/proc/self/ns/mnt");
    struct utsname u = {0}; o = (struct observation){0};
    if (uname(&u)) o.error = errno;
    else { memcpy(bytes, &u, sizeof(u)); o.length = sizeof(u); o.eof = true; }
    emit("uname", "syscall:uname", o, false);
    file_record("version", "/proc/version", 16 * 1024);
    file_record("osrelease", "/proc/sys/kernel/osrelease", 16 * 1024);
    file_record("boot_id", "/proc/sys/kernel/random/boot_id", 4096);
    file_record("notes", "/sys/kernel/notes", 1024 * 1024);
    file_record("cmdline", "/proc/cmdline", 16 * 1024);
    file_record("mountinfo", "/proc/self/mountinfo", 64 * 1024);
    file_record("modules", "/proc/modules", 64 * 1024);
    struct stat st; bool absent = false; o = (struct observation){0};
    if (lstat("/sys/module/brd", &st)) {
        o.error = errno; absent = errno == ENOENT;
        if (absent) { memcpy(bytes, "absent\n", 7); o.length = 7; o.eof = true; }
    } else { memcpy(bytes, "present\n", 8); o.length = 8; o.eof = true; all_ok = false; }
    emit("brd_presence", "/sys/module/brd", o, absent);
    o = (struct observation){0}; DIR *dir = opendir("/sys/block");
    if (!dir) o.error = errno;
    else {
        size_t count = 0;
        for (;;) {
            errno = 0; struct dirent *entry = readdir(dir);
            if (!entry) { o.error = errno; o.eof = !errno; break; }
            if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
            size_t n = strlen(entry->d_name) + 1;
            if (++count > 256 || o.length + n > 64 * 1024) { o.error = EFBIG; break; }
            memcpy(bytes + o.length, entry->d_name, n); o.length += n;
        }
        if (closedir(dir)) o.close_error = errno;
    }
    emit("sys_block", "/sys/block", o, false);
    o = read_file("/proc/self/status", 64 * 1024);
    identity = !o.error && !o.close_error && o.eof && ordinary_status(o.length);
    emit("status_after", "/proc/self/status", o, false);
    if (!identity) all_ok = false;
    o = (struct observation){.error = all_ok ? 0 : EPROTO, .eof = true};
    emit("end", "collector:end", o, false);
    return all_ok ? 0 : 1;
}

static int drop_identity(void) {
    struct observation o = read_file("/proc/sys/kernel/cap_last_cap", 16);
    char *end = NULL; errno = 0;
    long last = strtol((char *)bytes, &end, 10);
    if (o.error || o.close_error || !o.eof || errno || end == (char *)bytes ||
        (*end && strcmp(end, "\n")) || last < 0 || last > CAP_LAST_CAP || last >= 64)
        return management_fail("cap-last-cap", o.error ? o.error : o.close_error ? o.close_error : EINVAL);
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0L, 0L, 0L)) return management_fail("ambient-clear", errno);
    if (prctl(PR_SET_KEEPCAPS, 0L, 0L, 0L, 0L)) return management_fail("keepcaps-clear", errno);
    if (prctl(PR_GET_KEEPCAPS, 0L, 0L, 0L, 0L) != 0) return management_fail("keepcaps-confirm", errno ? errno : EINVAL);
    for (long bit = 0; bit <= last; ++bit) {
        if (prctl(PR_CAPBSET_DROP, bit, 0L, 0L, 0L)) return management_fail("bounding-drop", errno);
        if (prctl(PR_CAPBSET_READ, bit, 0L, 0L, 0L) != 0) return management_fail("bounding-confirm", errno ? errno : EINVAL);
    }
    if (setgroups(0, NULL)) return management_fail("groups-clear", errno);
    if (setresgid(1000, 1000, 1000)) return management_fail("gid-set", errno);
    if (setresuid(1000, 1000, 1000)) return management_fail("uid-set", errno);
    struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct data[2] = {{0}, {0}};
    if (syscall(SYS_capset, &header, data)) return management_fail("capset-clear", errno);
    if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L)) return management_fail("nnp-set", errno);
    return 0;
}

static double monotonic(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(71);
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}

static int bootstrap(void) {
    if (getpid() != 1 || getuid() != 0 || geteuid() != 0) return management_fail("pid1-root-required", EPERM);
    int gate[2];
    if (pipe2(gate, O_CLOEXEC)) return management_fail("child-gate-pipe", errno);
    pid_t child = fork();
    if (child < 0) { int error = errno; close(gate[0]); close(gate[1]); return management_fail("fork", error); }
    if (!child) {
        close(gate[1]); char ack;
        ssize_t got = read(gate[0], &ack, 1); int closed = close(gate[0]);
        if (got != 1 || ack != 'G' || closed) _exit(management_fail("child-ack", errno ? errno : EPROTO));
        if (drop_identity()) _exit(77);
        char *args[] = {"/bin/brd-helper", "collect", NULL};
        char *env[] = {"PATH=/bin", "LANG=C", NULL};
        execve(args[0], args, env); _exit(management_fail("collect-exec", errno));
    }
    close(gate[0]); int pidfd = (int)syscall(SYS_pidfd_open, child, 0);
    if (pidfd < 0) { int error = errno; close(gate[1]); waitpid(child, NULL, 0); return management_fail("child-pidfd", error); }
    printf("BRDF1 {\"run_id\":\"%s\",\"origin\":\"management\",\"event\":\"ordinary-start\"}\n", run_id);
    if (fflush(stdout) || write(gate[1], "G", 1) != 1) { close(gate[1]); close(pidfd); return 74; }
    close(gate[1]); int status = 0; bool timed_out = false; double deadline = monotonic() + 3.0;
    for (;;) {
        pid_t done = waitpid(child, &status, WNOHANG);
        if (done == child) break;
        if (done < 0) { close(pidfd); return 71; }
        if (monotonic() >= deadline) {
            timed_out = true;
            if (syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0) || waitpid(child, &status, 0) != child) { close(pidfd); return 71; }
            break;
        }
        struct timespec pause = {0, 1000000}; nanosleep(&pause, NULL);
    }
    int close_error = close(pidfd) ? errno : 0;
    printf("BRDF1 {\"run_id\":\"%s\",\"origin\":\"management\",\"event\":\"ordinary-exit\","
           "\"exit\":%d,\"signal\":%d,\"timeout\":%s,\"pidfd_close_errno\":%d}\n", run_id,
           WIFEXITED(status) ? WEXITSTATUS(status) : -1, WIFSIGNALED(status) ? WTERMSIG(status) : 0,
           timed_out ? "true" : "false", close_error);
    if (fflush(stdout) || close_error) return 74;
    if (reboot(RB_POWER_OFF)) return management_fail("poweroff", errno);
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 2 || (strcmp(argv[1], "bootstrap") && strcmp(argv[1], "collect"))) return 64;
    struct observation o = read_file("/run/run-id", 64);
    if (o.error || o.close_error || !o.eof || o.length != 37 || bytes[36] != '\n') return 65;
    for (size_t i = 0; i < 36; ++i) {
        bool dash = i == 8 || i == 13 || i == 18 || i == 23;
        if ((dash && bytes[i] != '-') || (!dash && !((bytes[i] >= '0' && bytes[i] <= '9') || (bytes[i] >= 'a' && bytes[i] <= 'f')))) return 65;
    }
    if (bytes[14] != '4' || !strchr("89ab", bytes[19])) return 65;
    memcpy(run_id, bytes, 36); run_id[36] = 0;
    return !strcmp(argv[1], "bootstrap") ? bootstrap() : collect();
}
