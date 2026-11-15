/* Private guest-only F2. The original collector/identity primitives remain unchanged. */
#define main f0b_guest_main
#include "guest.c"
#undef main
#include <inttypes.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <stddef.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/statfs.h>
#include <sys/sysmacros.h>
#include "../fs-source-preservation/uapi.h"

/* F2_EXPECTED_NOTES and F2_EXPECTED_CONFIG are generated from hash-checked inputs. */
#ifndef F2_FIXED_INPUTS
#error "Compile only with the fixed offline input header"
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
#define STATX_MNT_ID_UNIQUE 0x4000U
#endif
_Static_assert(sizeof(struct statx) == 256 && offsetof(struct statx, stx_mnt_id) == 144, "fixed statx ABI");
_Static_assert(sizeof(struct fsuuid2) == 17 && FS_IOC_GETFSUUID == 0x80111500UL, "fixed UUID ABI");

static const char cmdline[] = "console=ttyS0,115200n8 rdinit=/init loglevel=4 panic=0 bdev_allow_write_mounted=0\n";
static const char kernel_version[] = "#17~24.04.1-Ubuntu SMP PREEMPT Thu Sep 24 18:46:57 UTC 2026";
static const char feature_list[] = "none,has_journal,ext_attr,resize_inode,dir_index,filetype,extent,64bit,flex_bg,sparse_super,large_file,huge_file,dir_nlink,extra_isize,metadata_csum";
static char fs_uuid[37], hash_seed[37];
static unsigned management_sequence;
static bool output_error;
static struct { int fd, error; } parent_closes[128];
static unsigned parent_close_count;

static int close_once(int *fd) {
    if (*fd < 0) return 0;
    int saved = *fd; *fd = -1;
    int error = close(saved) ? errno : 0;
    if (getpid() == 1) {
        if (parent_close_count < 128) { parent_closes[parent_close_count].fd = saved; parent_closes[parent_close_count++].error = error; }
        else output_error = true;
    }
    return error;
}

static void hex_bytes(const unsigned char *data, size_t n) {
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < n; ++i) { putchar(hex[data[i] >> 4]); putchar(hex[data[i] & 15]); }
}

static void event(const char *name, int rc, int error, int close_error, const void *data, size_t length) {
    printf("BRDF2 {\"run_id\":\"%s\",\"origin\":\"management\",\"seq\":%u,\"event\":\"%s\","
           "\"rc\":%d,\"errno\":%d,\"close_errno\":%d,\"bytes\":%zu,\"data_hex\":\"",
           run_id, ++management_sequence, name, rc, error, close_error, length);
    hex_bytes(data, length); puts("\"}");
    /* The owner must keep unwinding even when its evidence channel fails. */
    if (fflush(stdout) || ferror(stdout)) output_error = true;
}

static bool emit2(const char *item, const char *path, struct observation o, bool absent) {
    bool ok = !o.close_error && o.eof && (!o.error || (absent && o.error == ENOENT));
    if (!ok) all_ok = false;
    printf("BRDF2 {\"run_id\":\"%s\",\"origin\":\"ordinary\",\"phase\":\"metadata\",\"seq\":%u,"
           "\"item\":\"%s\",\"path\":\"%s\",\"status\":\"%s\",\"errno\":%d,\"close_errno\":%d,"
           "\"eof\":%s,\"bytes\":%zu,\"data_hex\":\"", run_id, ++sequence, item, path,
           ok ? (absent ? "ABSENT" : "OK") : "ERROR", o.error, o.close_error, o.eof ? "true" : "false", o.length);
    hex_bytes(bytes, o.length); puts("\"}");
    if (fflush(stdout) || ferror(stdout)) _exit(74);
    return ok;
}

static struct observation enumerate(const char *path, bool reject_ram) {
    struct observation o = {0}; DIR *dir = opendir(path);
    if (!dir) { o.error = errno; return o; }
    unsigned count = 0;
    for (;;) {
        errno = 0; struct dirent *entry = readdir(dir);
        if (!entry) { o.error = errno; o.eof = !errno; break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        size_t n = strlen(entry->d_name) + 1;
        if (++count > 256 || o.length + n > 65536) { o.error = EFBIG; break; }
        if (reject_ram && !strncmp(entry->d_name, "ram", 3)) all_ok = false;
        memcpy(bytes + o.length, entry->d_name, n); o.length += n;
    }
    if (closedir(dir)) o.close_error = errno;
    return o;
}

static void checked_record(const char *item, const char *path, size_t limit, const void *expected, size_t length) {
    struct observation o = read_file(path, limit);
    bool match = !o.error && !o.close_error && o.eof && o.length == length && !memcmp(bytes, expected, length);
    emit(item, path, o, false);
    if (!match) all_ok = false;
}

static int collect_p1(void) {
    sequence = 0; all_ok = true;
    struct observation o = read_file("/proc/self/status", 65536);
    bool identity = !o.error && !o.close_error && o.eof && ordinary_status(o.length);
    emit("status_before", "/proc/self/status", o, false);
    if (!identity) return 77;
    file_record("self_stat", "/proc/self/stat", 8192);
    file_record("uid_map", "/proc/self/uid_map", 4096);
    file_record("gid_map", "/proc/self/gid_map", 4096);
    link_record("ns_pid", "/proc/self/ns/pid");
    link_record("ns_user", "/proc/self/ns/user");
    link_record("ns_mnt", "/proc/self/ns/mnt");
    struct utsname u = {0}; o = (struct observation){0};
    if (uname(&u)) o.error = errno;
    else {
        if (strcmp(u.sysname, "Linux") || strcmp(u.release, "7.0.0-1017-azure") ||
            strcmp(u.version, kernel_version) || strcmp(u.machine, "x86_64")) all_ok = false;
        memcpy(bytes, &u, sizeof(u)); o.length = sizeof(u); o.eof = true;
    }
    emit("uname", "syscall:uname", o, false);
    file_record("version", "/proc/version", 16384);
    checked_record("osrelease", "/proc/sys/kernel/osrelease", 16384, "7.0.0-1017-azure\n", 17);
    file_record("boot_id", "/proc/sys/kernel/random/boot_id", 4096);
    checked_record("notes", "/sys/kernel/notes", 1024 * 1024, F2_EXPECTED_NOTES, sizeof(F2_EXPECTED_NOTES));
    checked_record("cmdline", "/proc/cmdline", 16384, cmdline, sizeof(cmdline) - 1);
    file_record("mountinfo", "/proc/self/mountinfo", 65536);
    checked_record("modules", "/proc/modules", 65536, "", 0);
    struct stat st = {0}; bool absent = false; o = (struct observation){0};
    if (lstat("/sys/module/brd", &st)) {
        o.error = errno; absent = errno == ENOENT;
        if (absent) { memcpy(bytes, "absent\n", 7); o.length = 7; o.eof = true; }
    } else { memcpy(bytes, "present\n", 8); o.length = 8; o.eof = true; all_ok = false; }
    emit("brd_presence", "/sys/module/brd", o, absent);
    o = enumerate("/sys/block", true); emit("sys_block", "/sys/block", o, false);
    o = read_file("/proc/self/status", 65536);
    identity = !o.error && !o.close_error && o.eof && ordinary_status(o.length);
    emit("status_after", "/proc/self/status", o, false);
    if (!identity) all_ok = false;
    o = (struct observation){.error = all_ok ? 0 : EPROTO, .eof = true};
    emit("end", "collector:end", o, false);
    return all_ok ? 0 : 1;
}

struct child_result { pid_t pid; int code, signal, error, close_error; bool timed_out, reaped, pidfd_before_ack; };

static struct child_result ordinary_child(const char *mode) {
    struct child_result r = {.code = -1}; int gate[2] = {-1, -1}, pidfd = -1;
    if (pipe2(gate, O_CLOEXEC)) { r.error = errno; return r; }
    r.pid = fork();
    if (r.pid == 0) {
        if (close_once(&gate[1])) _exit(74);
        char ack = 0; ssize_t n = read(gate[0], &ack, 1); int ce = close_once(&gate[0]);
        if (n != 1 || ack != 'G' || ce || drop_identity()) _exit(77);
        char *argv[] = {"/bin/brd-f2", (char *)mode, NULL};
        char *env[] = {"PATH=/bin", "LANG=C", NULL};
        execve(argv[0], argv, env); _exit(78);
    }
    if (r.pid < 0) { r.error = errno; goto out; }
    r.close_error = close_once(&gate[0]);
    pidfd = (int)syscall(SYS_pidfd_open, r.pid, 0);
    if (pidfd < 0) r.error = errno;
    else r.pidfd_before_ack = true;
    if (!strcmp(mode, "p1")) {
        printf("BRDF1 {\"run_id\":\"%s\",\"origin\":\"management\",\"event\":\"ordinary-start\"}\n", run_id);
        if (fflush(stdout)) output_error = true;
    }
    event(!strcmp(mode, "p1") ? "p1-start" : "metadata-start", 0, 0, 0, "", 0);
    if (!r.error && !r.close_error && !output_error && write(gate[1], "G", 1) != 1) r.error = errno ? errno : EIO;
    int ce = close_once(&gate[1]); if (!r.close_error) r.close_error = ce;
    int status = 0; double deadline = monotonic() + 3.0; bool killed = false;
    for (;;) {
        pid_t done = waitpid(r.pid, &status, WNOHANG);
        if (done == r.pid) { r.reaped = true; break; }
        if (done < 0) { if (!r.error) r.error = errno; break; }
        if (!killed && (r.error || r.close_error || output_error || monotonic() >= deadline)) {
            r.timed_out = monotonic() >= deadline;
            int kr = pidfd >= 0 ? (int)syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0) : kill(r.pid, SIGKILL);
            if (kr && errno != ESRCH && !r.error) r.error = errno;
            killed = true; deadline = monotonic() + 2.0;
        } else if (killed && monotonic() >= deadline) { if (!r.error) r.error = ETIMEDOUT; break; }
        struct timespec pause = {0, 1000000}; nanosleep(&pause, NULL);
    }
    if (r.reaped) { r.code = WIFEXITED(status) ? WEXITSTATUS(status) : -1; r.signal = WIFSIGNALED(status) ? WTERMSIG(status) : 0; }
out:
    { int e = close_once(&gate[0]); if (!r.close_error) r.close_error = e; }
    { int e = close_once(&gate[1]); if (!r.close_error) r.close_error = e; }
    { int e = close_once(&pidfd); if (!r.close_error) r.close_error = e; }
    if (!strcmp(mode, "p1")) {
        printf("BRDF1 {\"run_id\":\"%s\",\"origin\":\"management\",\"event\":\"ordinary-exit\","
               "\"exit\":%d,\"signal\":%d,\"timeout\":%s,\"pidfd_close_errno\":%d}\n",
               run_id, r.code, r.signal, r.timed_out ? "true" : "false", r.close_error);
        if (fflush(stdout)) output_error = true;
    }
    char summary[512]; int n = snprintf(summary, sizeof(summary),
        "{\"pid\":%d,\"exit\":%d,\"signal\":%d,\"timeout\":%s,\"reaped\":%s,\"pidfd_before_ack\":%s}",
        r.pid, r.code, r.signal, r.timed_out ? "true" : "false", r.reaped ? "true" : "false", r.pidfd_before_ack ? "true" : "false");
    bool ok = r.reaped && r.code == 0 && !r.signal && !r.timed_out && !r.error && !r.close_error && r.pidfd_before_ack;
    event(!strcmp(mode, "p1") ? "p1-exit" : "metadata-exit", ok ? 0 : -1, r.error ? r.error : ok ? 0 : ECHILD,
          r.close_error, summary, (size_t)n);
    return r;
}

static bool child_ok(struct child_result r) {
    return r.reaped && r.code == 0 && !r.signal && !r.timed_out && !r.error && !r.close_error && r.pidfd_before_ack;
}

static void meta_file(const char *item, const char *path, size_t limit) {
    struct observation o = read_file(path, limit); emit2(item, path, o, false);
}

static void meta_stat(const char *item, int fd) {
    struct stat s = {0}; errno = 0; int rc = fstat(fd, &s), error = rc ? errno : 0;
    int n = snprintf((char *)bytes, sizeof(bytes),
        "{\"fd\":%d,\"dev\":%ju,\"ino\":%ju,\"mode\":%u,\"uid\":%u,\"gid\":%u,\"nlink\":%ju,\"size\":%jd,"
        "\"mtime\":[%jd,%ld],\"ctime\":[%jd,%ld]}", fd, (uintmax_t)s.st_dev, (uintmax_t)s.st_ino, s.st_mode,
        s.st_uid, s.st_gid, (uintmax_t)s.st_nlink, (intmax_t)s.st_size, (intmax_t)s.st_mtim.tv_sec, s.st_mtim.tv_nsec,
        (intmax_t)s.st_ctim.tv_sec, s.st_ctim.tv_nsec);
    struct observation o = {.length = (size_t)n, .error = error, .eof = true}; emit2(item, "source:/mnt/brd", o, false);
}

static void meta_syscall(const char *item, const char *path, int rc, int error, const void *data, size_t size) {
    memcpy(bytes, data, size);
    struct observation o = {.length = size, .error = rc ? error : 0, .eof = true}; emit2(item, path, o, false);
}

static int metadata(void) {
    sequence = 0; all_ok = true; int fd = -1;
    struct observation o = read_file("/proc/self/status", 65536);
    bool identity = !o.error && !o.close_error && o.eof && ordinary_status(o.length);
    emit2("status_before", "/proc/self/status", o, false);
    if (!identity) return 77;
    meta_file("self_stat", "/proc/self/stat", 8192);
    meta_file("boot_id", "/proc/sys/kernel/random/boot_id", 4096);
    meta_file("module_notes", "/sys/module/brd/notes/.note.gnu.build-id", 4096);
    meta_file("module_srcversion", "/sys/module/brd/srcversion", 4096);
    meta_file("module_rd_nr", "/sys/module/brd/parameters/rd_nr", 4096);
    meta_file("module_rd_size", "/sys/module/brd/parameters/rd_size", 4096);
    meta_file("module_max_part", "/sys/module/brd/parameters/max_part", 4096);
    meta_file("modules", "/proc/modules", 65536);
    o = enumerate("/sys/block", false); emit2("sys_block", "/sys/block", o, false);
    meta_file("device_dev", "/sys/block/ram0/dev", 4096);
    meta_file("device_size", "/sys/block/ram0/size", 4096);
    meta_file("device_logical", "/sys/block/ram0/queue/logical_block_size", 4096);
    meta_file("device_physical", "/sys/block/ram0/queue/physical_block_size", 4096);
    meta_file("device_ro", "/sys/block/ram0/ro", 4096);
    struct stat part = {0}; o = (struct observation){0};
    if (lstat("/sys/block/ram0/partition", &part)) {
        o.error = errno; o.eof = true;
        if (o.error == ENOENT) { memcpy(bytes, "absent\n", 7); o.length = 7; }
    } else { memcpy(bytes, "present\n", 8); o.length = 8; o.eof = true; all_ok = false; }
    emit2("device_partition", "/sys/block/ram0/partition", o, o.error == ENOENT);
    o = enumerate("/sys/block/ram0/holders", false); emit2("device_holders", "/sys/block/ram0/holders", o, false);
    o = enumerate("/sys/block/ram0/slaves", false); emit2("device_slaves", "/sys/block/ram0/slaves", o, false);
    fd = open("/mnt/brd", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NOATIME | O_CLOEXEC);
    o = (struct observation){.error = fd < 0 ? errno : 0, .eof = true};
    int n = snprintf((char *)bytes, sizeof(bytes), "{\"fd\":%d}", fd); o.length = (size_t)n;
    emit2("source_open", "source:/mnt/brd", o, false);
    if (fd >= 0) {
        meta_stat("source_stat_before", fd);
        struct statfs fs = {0}; errno = 0; int rc = fstatfs(fd, &fs), error = rc ? errno : 0;
        n = snprintf((char *)bytes, sizeof(bytes), "{\"magic\":%lu,\"block_size\":%ld}", (unsigned long)fs.f_type, fs.f_bsize);
        o = (struct observation){.length = (size_t)n, .error = error, .eof = true}; emit2("source_statfs", "source:/mnt/brd", o, false);
        struct statx sx = {0}; errno = 0;
        rc = (int)syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS | STATX_MNT_ID, &sx); error = rc ? errno : 0;
        meta_syscall("source_statx_legacy", "syscall:statx-legacy", rc, error, &sx, sizeof(sx));
        memset(&sx, 0, sizeof(sx)); errno = 0;
        rc = (int)syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS | STATX_BTIME | STATX_MNT_ID_UNIQUE, &sx); error = rc ? errno : 0;
        meta_syscall("source_statx_unique", "syscall:statx-unique", rc, error, &sx, sizeof(sx));
        struct fsuuid2 uuid = {0}; errno = 0; rc = ioctl(fd, FS_IOC_GETFSUUID, &uuid); error = rc ? errno : 0;
        meta_syscall("source_uuid", "ioctl:GETFSUUID", rc, error, &uuid, sizeof(uuid));
        union { max_align_t align; unsigned char raw[sizeof(struct file_handle) + 128]; } h = {0};
        struct file_handle *fh = (void *)h.raw; fh->handle_bytes = 128; uint64_t mount_id = 0; errno = 0;
        rc = (int)syscall(SYS_name_to_handle_at, fd, "", fh, &mount_id, AT_EMPTY_PATH | AT_HANDLE_FID | AT_HANDLE_MNT_ID_UNIQUE); error = rc ? errno : 0;
        unsigned char fid[144] = {0}; memcpy(fid, &mount_id, 8); memcpy(fid + 8, h.raw, sizeof(h.raw));
        meta_syscall("source_fid", "syscall:name_to_handle_at", rc, error, fid, sizeof(fid));
        struct r04_tune tune = {0}; errno = 0; rc = ioctl(fd, R04_GET_TUNE, &tune); error = rc ? errno : 0;
        meta_syscall("source_tune", "ioctl:GET_TUNE", rc, error, &tune, sizeof(tune));
        long flags = 0; errno = 0; rc = ioctl(fd, FS_IOC_GETFLAGS, &flags); error = rc ? errno : 0;
        meta_syscall("source_flags", "ioctl:GETFLAGS", rc, error, &flags, sizeof(flags));
        union { max_align_t align; unsigned char raw[16384]; } sm = {0};
        struct r04_mnt_id_req req = {.size = sizeof(req), .mnt_id = sx.stx_mnt_id, .param = R04_MOUNT_MASK}; errno = 0;
        rc = (int)syscall(SYS_statmount, &req, sm.raw, sizeof(sm.raw), 0); error = rc ? errno : 0;
        struct r04_statmount *m = (void *)sm.raw;
        size_t length = rc == 0 && m->size >= 512 && m->size <= sizeof(sm.raw) ? m->size : sizeof(sm.raw);
        meta_syscall("source_mount", "syscall:statmount", rc, error, sm.raw, length);
        meta_file("effective_options", "/proc/fs/ext4/ram0/options", 16384);
        static const char *health[] = {"errors_count", "first_error_errcode", "last_error_errcode", "first_error_ino", "last_error_ino",
            "first_error_block", "last_error_block", "first_error_line", "last_error_line", "first_error_time", "last_error_time",
            "first_error_func", "last_error_func"};
        for (size_t i = 0; i < sizeof(health) / sizeof(health[0]); ++i) {
            char path[128], item[64]; snprintf(path, sizeof(path), "/sys/fs/ext4/ram0/%s", health[i]);
            snprintf(item, sizeof(item), "health_%s", health[i]); meta_file(item, path, 4096);
        }
        meta_file("mountinfo", "/proc/self/mountinfo", 65536);
        meta_stat("source_stat_after", fd);
    }
    int ce = close_once(&fd); o = (struct observation){.error = ce, .eof = true};
    emit2("source_close", "source:/mnt/brd", o, false);
    o = read_file("/proc/self/status", 65536);
    identity = !o.error && !o.close_error && o.eof && ordinary_status(o.length);
    emit2("status_after", "/proc/self/status", o, false); if (!identity) all_ok = false;
    o = (struct observation){.error = all_ok ? 0 : EPROTO, .eof = true}; emit2("end", "collector:end", o, false);
    return all_ok ? 0 : 1;
}

static struct stat owned_node;

static int device_open(void) {
    int fd = open("/dev/ram0", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return -1;
    struct stat s = {0};
    if (fstat(fd, &s) || !S_ISBLK(s.st_mode) || s.st_rdev != makedev(1, 0) ||
        s.st_dev != owned_node.st_dev || s.st_ino != owned_node.st_ino || s.st_uid != 0 || s.st_gid != 0) {
        int error = errno ? errno : ESTALE; close_once(&fd); errno = error; return -1;
    }
    return fd;
}

static int config_check(void) {
    int fd = open("/etc/mke2fs-f2.conf", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    int error = fd < 0 ? errno : 0; struct stat a = {0}, b = {0}; size_t length = 0;
    if (!error && (fstat(fd, &a) || !S_ISREG(a.st_mode) || a.st_uid || a.st_gid || a.st_nlink != 1 ||
                   (a.st_mode & 07777) != 0444 || a.st_size != (off_t)sizeof(F2_EXPECTED_CONFIG))) error = errno ? errno : EINVAL;
    if (!error) {
        ssize_t n = read(fd, bytes, sizeof(F2_EXPECTED_CONFIG) + 1);
        if (n < 0) error = errno;
        else {
            length = (size_t)n;
            if (length != sizeof(F2_EXPECTED_CONFIG) || memcmp(bytes, F2_EXPECTED_CONFIG, length)) error = EINVAL;
        }
    }
    if (!error && (fstat(fd, &b) || a.st_dev != b.st_dev || a.st_ino != b.st_ino || a.st_size != b.st_size ||
                   a.st_mtim.tv_sec != b.st_mtim.tv_sec || a.st_mtim.tv_nsec != b.st_mtim.tv_nsec ||
                   a.st_ctim.tv_sec != b.st_ctim.tv_sec || a.st_ctim.tv_nsec != b.st_ctim.tv_nsec)) error = errno ? errno : ESTALE;
    int ce = close_once(&fd);
    event("config-check", error ? -1 : 0, error, ce, bytes, length);
    return error ? error : ce;
}

static int family_check(void) {
    all_ok = true;
    struct observation o = enumerate("/sys/block", false); unsigned count = 0; bool extra = false;
    if (!o.error && !o.close_error && o.eof) {
        for (size_t off = 0; off < o.length;) {
            const char *name = (const char *)bytes + off;
            if (!strncmp(name, "ram", 3)) { ++count; if (strcmp(name, "ram0")) extra = true; }
            off += strlen(name) + 1;
        }
    }
    int error = o.error ? o.error : o.close_error ? o.close_error : !o.eof || count != 1 || extra ? EPROTO : 0;
    event("brd-family", error ? -1 : 0, error, o.close_error, bytes, o.length);
    return error;
}

static struct child_result format_child(void) {
    struct child_result r = {.code = -1}; int out[2] = {-1, -1}, err[2] = {-1, -1}, gate[2] = {-1, -1};
    int executable = -1, nullfd = -1, pidfd = -1; unsigned char captured[2][65536] = {{0}}; size_t lengths[2] = {0, 0};
    bool eof[2] = {false, false};
    executable = open("/usr/sbin/mke2fs", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat ex = {0};
    if (executable < 0) { r.error = errno; goto finish; }
    if (fstat(executable, &ex) || !S_ISREG(ex.st_mode) || ex.st_uid || ex.st_gid ||
        ex.st_size != 146000 || (ex.st_mode & 07777) != 0555 || ex.st_nlink != 1) { r.error = errno ? errno : EINVAL; goto finish; }
    nullfd = open("/dev/null", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (nullfd < 0 || pipe2(out, O_CLOEXEC) || pipe2(err, O_CLOEXEC) || pipe2(gate, O_CLOEXEC)) { r.error = errno; goto finish; }
    if (fcntl(out[0], F_SETFL, O_NONBLOCK) || fcntl(err[0], F_SETFL, O_NONBLOCK)) { r.error = errno; goto finish; }
    r.pid = fork();
    if (r.pid < 0) { r.error = errno; goto finish; }
    if (r.pid == 0) {
        int failed = 0;
        int *unused[] = {&out[0], &err[0], &gate[1]};
        for (size_t i = 0; i < sizeof(unused) / sizeof(unused[0]); ++i) { int e = close_once(unused[i]); if (e && !failed) failed = e; }
        if (failed) _exit(123);
        char ack = 0; ssize_t n = read(gate[0], &ack, 1); int ce = close_once(&gate[0]);
        if (n != 1 || ack != 'G' || ce) _exit(124);
        if (dup2(nullfd, 0) != 0 || dup2(out[1], 1) != 1 || dup2(err[1], 2) != 2) _exit(125);
        int *redirected[] = {&nullfd, &out[1], &err[1]};
        for (size_t i = 0; i < sizeof(redirected) / sizeof(redirected[0]); ++i) { int e = close_once(redirected[i]); if (e && !failed) failed = e; }
        if (failed) _exit(125);
        char extended[256]; snprintf(extended, sizeof(extended),
            "lazy_itable_init=0,lazy_journal_init=0,nodiscard,assume_storage_prezeroed=0,hash_seed=%s", hash_seed);
        char *args[] = {"/usr/sbin/mke2fs", "-t", "ext4", "-T", "brd64", "-b", "4096", "-I", "256", "-i", "16384", "-m", "0",
            "-U", fs_uuid, "-J", "size=4", "-O", (char *)feature_list, "-E", extended, "/dev/ram0", "16384", NULL};
        char *env[] = {"PATH=/usr/sbin:/bin", "LANG=C", "LC_ALL=C", "MKE2FS_CONFIG=/etc/mke2fs-f2.conf", NULL};
        syscall(SYS_execveat, executable, "", args, env, AT_EMPTY_PATH);
        dprintf(2, "BRDF2-MKE2FS-EXEC-ERRNO=%d\n", errno); _exit(126);
    }
    { int e = close_once(&gate[0]); if (!r.close_error) r.close_error = e; }
    { int e = close_once(&out[1]); if (!r.close_error) r.close_error = e; }
    { int e = close_once(&err[1]); if (!r.close_error) r.close_error = e; }
    { int e = close_once(&executable); if (!r.close_error) r.close_error = e; }
    { int e = close_once(&nullfd); if (!r.close_error) r.close_error = e; }
    pidfd = (int)syscall(SYS_pidfd_open, r.pid, 0);
    if (pidfd < 0) r.error = errno; else r.pidfd_before_ack = true;
    event("format-start", 0, 0, r.close_error, "", 0);
    if (!r.error && !r.close_error && !output_error && write(gate[1], "G", 1) != 1) r.error = errno ? errno : EIO;
    { int e = close_once(&gate[1]); if (!r.close_error) r.close_error = e; }
    double deadline = monotonic() + 30.0; bool killed = false; int status = 0;
    while (!r.reaped || !eof[0] || !eof[1]) {
        if (!r.reaped) {
            pid_t done = waitpid(r.pid, &status, WNOHANG);
            if (done == r.pid) r.reaped = true;
            else if (done < 0) { if (!r.error) r.error = errno; break; }
        }
        int fds[2] = {out[0], err[0]};
        for (int i = 0; i < 2; ++i) {
            if (eof[i]) continue;
            unsigned char chunk[4096]; ssize_t n = read(fds[i], chunk, sizeof(chunk));
            if (n > 0) {
                size_t room = sizeof(captured[i]) - lengths[i]; size_t save = (size_t)n < room ? (size_t)n : room;
                memcpy(captured[i] + lengths[i], chunk, save); lengths[i] += save;
                if (save != (size_t)n && !r.error) r.error = EFBIG;
            } else if (!n) eof[i] = true;
            else if (errno != EAGAIN && errno != EINTR) { if (!r.error) r.error = errno; eof[i] = true; }
        }
        if (!killed && !r.reaped && (r.error || r.close_error || output_error || monotonic() >= deadline)) {
            r.timed_out = monotonic() >= deadline;
            int kr = pidfd >= 0 ? (int)syscall(SYS_pidfd_send_signal, pidfd, SIGKILL, NULL, 0) : kill(r.pid, SIGKILL);
            if (kr && errno != ESRCH && !r.error) r.error = errno;
            killed = true; deadline = monotonic() + 2.0;
        }
        if (monotonic() >= deadline && (!r.reaped || !eof[0] || !eof[1])) { if (!r.error) r.error = ETIMEDOUT; break; }
        struct timespec pause = {0, 1000000}; nanosleep(&pause, NULL);
    }
    if (r.reaped) { r.code = WIFEXITED(status) ? WEXITSTATUS(status) : -1; r.signal = WIFSIGNALED(status) ? WTERMSIG(status) : 0; }
finish:
    { int *fds[] = {&out[0], &out[1], &err[0], &err[1], &gate[0], &gate[1], &executable, &nullfd, &pidfd};
      for (size_t i = 0; i < sizeof(fds) / sizeof(fds[0]); ++i) { int e = close_once(fds[i]); if (!r.close_error) r.close_error = e; } }
    event("format-stdout", 0, 0, 0, captured[0], lengths[0]);
    event("format-stderr", 0, 0, 0, captured[1], lengths[1]);
    char summary[512]; int n = snprintf(summary, sizeof(summary),
        "{\"pid\":%d,\"exit\":%d,\"signal\":%d,\"timeout\":%s,\"reaped\":%s,\"pidfd_before_ack\":%s,\"stdout_eof\":%s,\"stderr_eof\":%s}",
        r.pid, r.code, r.signal, r.timed_out ? "true" : "false", r.reaped ? "true" : "false", r.pidfd_before_ack ? "true" : "false",
        eof[0] ? "true" : "false", eof[1] ? "true" : "false");
    bool ok = child_ok(r) && eof[0] && eof[1];
    event("format-exit", ok ? 0 : -1, r.error ? r.error : ok ? 0 : ECHILD, r.close_error, summary, (size_t)n);
    if (!ok && !r.error) r.error = ECHILD;
    return r;
}

static uint16_t le16(const unsigned char *p) { uint16_t n; memcpy(&n, p, 2); return n; }
static uint32_t le32(const unsigned char *p) { uint32_t n; memcpy(&n, p, 4); return n; }
static uint32_t be32(const unsigned char *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

static int read_at(int fd, void *target, size_t length, uint64_t offset) {
    if (offset > 64 * 1024 * 1024U || length > 64 * 1024 * 1024U - offset) return EFBIG;
    ssize_t n = pread(fd, target, length, (off_t)offset);
    return n < 0 ? errno : (size_t)n != length ? EIO : 0;
}

static int raw_metadata(const char *stage) {
    int fd = device_open(), error = fd < 0 ? errno : 0;
    unsigned char sb[1024] = {0}, gd[64] = {0}, inode[256] = {0}, journal[4096] = {0};
    if (!error) error = read_at(fd, sb, sizeof(sb), 1024);
    if (!error && (le16(sb + 56) != 0xef53 || le32(sb + 24) != 2 || le16(sb + 88) != 256 || le16(sb + 254) != 64 ||
        le32(sb + 4) != 16384 || le32(sb + 336) || le32(sb + 92) != 60 || le32(sb + 96) != 706 ||
        le32(sb + 100) != 1131 || le32(sb + 224) != 8 || memcmp(sb + 208, (unsigned char[16]){0}, 16))) error = EPROTO;
    if (!error) error = read_at(fd, gd, sizeof(gd), 4096);
    uint64_t table = (uint64_t)le32(gd + 8) | ((uint64_t)le32(gd + 40) << 32);
    if (!error) error = read_at(fd, inode, sizeof(inode), table * 4096 + 7 * 256);
    if (!error && ((le16(inode) & S_IFMT) != S_IFREG || le32(inode + 4) != 4 * 1024 * 1024 || le32(inode + 108) ||
        !(le32(inode + 32) & FS_EXTENT_FL) || le16(inode + 40) != 0xf30a ||
        le16(inode + 42) < 1 || le16(inode + 42) > 4 || le16(inode + 46) != 0 || le32(inode + 52) != 0 ||
        le16(inode + 56) < 1 || le16(inode + 56) > 32768)) error = EPROTO;
    uint64_t journal_block = (uint64_t)le32(inode + 60) | ((uint64_t)le16(inode + 58) << 32);
    if (!error) error = read_at(fd, journal, sizeof(journal), journal_block * 4096);
    if (!error && (be32(journal) != 0xc03b3998 || be32(journal + 4) != 4 || be32(journal + 12) != 4096 ||
                   be32(journal + 16) != 1024 || memcmp(journal + 48, sb + 104, 16))) error = EPROTO;
    int ce = close_once(&fd); char label[64];
    snprintf(label, sizeof(label), "%s-superblock", stage); event(label, error ? -1 : 0, error, ce, sb, sizeof(sb));
    snprintf(label, sizeof(label), "%s-group-descriptor", stage); event(label, error ? -1 : 0, error, ce, gd, sizeof(gd));
    snprintf(label, sizeof(label), "%s-journal-inode", stage); event(label, error ? -1 : 0, error, ce, inode, sizeof(inode));
    snprintf(label, sizeof(label), "%s-journal-header", stage); event(label, error ? -1 : 0, error, ce, journal, sizeof(journal));
    return error ? error : ce;
}

static int bootstrap_f2(void) {
    if (getpid() != 1 || getuid() != 0 || geteuid() != 0) return 77;
    bool loaded = false, node = false, mounted = false, children_done = true, metadata_ok = false;
    int original = 0, cleanup_error = 0, fd = -1, rc = 0, error = 0, ce = 0;
    struct child_result child = ordinary_child("p1");
    if (!child_ok(child) || output_error) { original = child.error ? child.error : child.close_error ? child.close_error : EPROTO; children_done = child.pid <= 0 || child.reaped; goto cleanup; }
    event("policy-gate", 0, 0, 0, "SOURCE_INFERRED_FALSE_FOR_CURRENT_BOOT", sizeof("SOURCE_INFERRED_FALSE_FOR_CURRENT_BOOT") - 1);
    if ((original = config_check()) || output_error) { if (!original) original = EIO; goto cleanup; }
    fd = open("/usr/lib/modules/brd.ko", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    error = fd < 0 ? errno : 0; struct stat module = {0};
    if (!error && (fstat(fd, &module) || !S_ISREG(module.st_mode) || module.st_uid || module.st_gid ||
        module.st_nlink != 1 || module.st_size != 30017 || (module.st_mode & 07777) != 0444)) error = errno ? errno : EINVAL;
    if (!error) { rc = (int)syscall(SYS_finit_module, fd, "rd_nr=1 rd_size=65536 max_part=1", 0); error = rc ? errno : 0; loaded = rc == 0; }
    ce = close_once(&fd); event("module-load", error ? -1 : 0, error, ce, "rd_nr=1 rd_size=65536 max_part=1", 32);
    if (error || ce || output_error) { original = error ? error : ce ? ce : EIO; goto cleanup; }
    if ((original = family_check()) || output_error) { if (!original) original = EIO; goto cleanup; }
    struct stat prior = {0}; errno = 0;
    if (lstat("/dev/ram0", &prior) == 0 || errno != ENOENT) { original = EEXIST; goto cleanup; }
    rc = mknod("/dev/ram0", S_IFBLK | 0600, makedev(1, 0)); error = rc ? errno : 0; node = rc == 0;
    if (!error && lstat("/dev/ram0", &owned_node)) error = errno;
    event("device-create", error ? -1 : 0, error, 0, "1:0", 3);
    if (error || output_error) { original = error ? error : EIO; goto cleanup; }
    fd = device_open(); error = fd < 0 ? errno : 0; uint64_t capacity = 0; unsigned logical = 0;
    if (!error && ioctl(fd, BLKGETSIZE64, &capacity)) error = errno;
    if (!error && ioctl(fd, BLKSSZGET, &logical)) error = errno;
    if (!error && (capacity != 64 * 1024 * 1024U || !logical || logical > 1024)) error = EPROTO;
    ce = close_once(&fd); char geometry[128]; int n = snprintf(geometry, sizeof(geometry), "{\"bytes\":%"PRIu64",\"logical_block_size\":%u}", capacity, logical);
    event("device-geometry", error ? -1 : 0, error, ce, geometry, (size_t)n);
    if (error || ce || output_error) { original = error ? error : ce ? ce : EIO; goto cleanup; }
    child = format_child(); children_done = child.pid <= 0 || child.reaped;
    if (!child_ok(child) || output_error) { original = child.error ? child.error : child.close_error ? child.close_error : EPROTO; goto cleanup; }
    if ((original = raw_metadata("prepared")) || output_error) { if (!original) original = EIO; goto cleanup; }
    rc = mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL); error = rc ? errno : 0;
    event("mount-private", rc, error, 0, "", 0);
    if (error || output_error) { original = error ? error : EIO; goto cleanup; }
    rc = mount("/dev/ram0", "/mnt/brd", "ext4", MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_RELATIME,
               "errors=remount-ro,data=ordered,acl,user_xattr,dax=never"); error = rc ? errno : 0; mounted = rc == 0;
    event("mount-fresh", rc, error, 0, "", 0);
    if (error || output_error) { original = error ? error : EIO; goto cleanup; }
    fd = open("/mnt/brd", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); error = fd < 0 ? errno : 0;
    struct stat root = {0};
    if (!error && (fstat(fd, &root) || root.st_ino != 2 || root.st_dev != makedev(1, 0))) error = errno ? errno : EPROTO;
    if (!error && (fchown(fd, 1000, 1000) || fchmod(fd, 0700))) error = errno;
    if (!error && fsync(fd)) error = errno;
    ce = close_once(&fd); event("ordinary-root", error ? -1 : 0, error, ce, "", 0);
    if (error || ce || output_error) { original = error ? error : ce ? ce : EIO; goto cleanup; }
    child = ordinary_child("metadata"); children_done = child.pid <= 0 || child.reaped; metadata_ok = child_ok(child);
    if (!metadata_ok || output_error) original = child.error ? child.error : child.close_error ? child.close_error : EPROTO;
cleanup:
    ce = close_once(&fd); if (ce && !cleanup_error) cleanup_error = ce;
    event("cleanup-fd", ce ? -1 : 0, ce, ce, "", 0);
    if (mounted && children_done) {
        struct stat source = {0};
        if (lstat("/mnt/brd", &source) || source.st_ino != 2 || source.st_dev != makedev(1, 0)) { error = errno ? errno : ESTALE; rc = -1; }
        else { rc = umount2("/mnt/brd", 0); error = rc ? errno : 0; if (!rc) mounted = false; }
        event("unmount", rc, error, 0, "", 0); if (error && !cleanup_error) cleanup_error = error;
        if (!error) { int e = raw_metadata("unmounted"); if (e && !cleanup_error) cleanup_error = e; }
    } else if (mounted) { event("unmount", -1, EBUSY, 0, "unreaped-child", 14); cleanup_error = EBUSY; }
    if (node && !mounted && children_done) {
        struct stat actual = {0};
        if (lstat("/dev/ram0", &actual) || actual.st_dev != owned_node.st_dev || actual.st_ino != owned_node.st_ino || actual.st_rdev != owned_node.st_rdev) { rc = -1; error = errno ? errno : ESTALE; }
        else { rc = unlink("/dev/ram0"); error = rc ? errno : 0; if (!rc) node = false; }
        event("device-remove", rc, error, 0, "", 0); if (error && !cleanup_error) cleanup_error = error;
    }
    if (loaded && !mounted && children_done) {
        rc = (int)syscall(SYS_delete_module, "brd", O_NONBLOCK); error = rc ? errno : 0; if (!rc) loaded = false;
        event("module-unload", rc, error, 0, "", 0); if (error && !cleanup_error) cleanup_error = error;
    }
    if (loaded || mounted || node || !children_done) { if (!cleanup_error) cleanup_error = EBUSY; }
    char summary[4096]; int len = snprintf(summary, sizeof(summary),
        "{\"original_errno\":%d,\"cleanup_errno\":%d,\"metadata_complete\":%s,\"module_loaded\":%s,\"mounted\":%s,\"node_exists\":%s,\"children_reaped\":%s,\"parent_closes\":[",
        original, cleanup_error, metadata_ok ? "true" : "false", loaded ? "true" : "false", mounted ? "true" : "false", node ? "true" : "false", children_done ? "true" : "false");
    for (unsigned i = 0; i < parent_close_count; ++i) {
        int added = snprintf(summary + len, sizeof(summary) - (size_t)len, "%s{\"fd\":%d,\"errno\":%d}", i ? "," : "", parent_closes[i].fd, parent_closes[i].error);
        if (added < 0 || (size_t)added >= sizeof(summary) - (size_t)len) { output_error = true; break; }
        len += added;
    }
    if ((size_t)len + 3 < sizeof(summary)) { memcpy(summary + len, "]}", 3); len += 2; } else output_error = true;
    bool ok = !original && !cleanup_error && !output_error && metadata_ok;
    event("guest-complete", ok ? 0 : -1, original ? original : cleanup_error ? cleanup_error : output_error ? EIO : 0, cleanup_error, summary, (size_t)len);
    if (reboot(RB_POWER_OFF)) { event("poweroff-failed", -1, errno, 0, "", 0); return 1; }
    return ok ? 0 : 1;
}

static int load_uuid(const char *path, char target[37]) {
    struct observation o = read_file(path, 64);
    if (o.error || o.close_error || !o.eof || o.length != 37 || bytes[36] != '\n') return 65;
    for (size_t i = 0; i < 36; ++i) {
        bool dash = i == 8 || i == 13 || i == 18 || i == 23;
        if ((dash && bytes[i] != '-') || (!dash && !((bytes[i] >= '0' && bytes[i] <= '9') || (bytes[i] >= 'a' && bytes[i] <= 'f')))) return 65;
    }
    if (bytes[14] != '4' || !strchr("89ab", bytes[19])) return 65;
    memcpy(target, bytes, 36); target[36] = 0; return 0;
}

#ifndef F2_PURE_TEST
int main(int argc, char **argv) {
    if (argc != 2 || (strcmp(argv[1], "bootstrap") && strcmp(argv[1], "p1") && strcmp(argv[1], "metadata"))) return 64;
    bool bootstrap_mode = !strcmp(argv[1], "bootstrap");
    if (bootstrap_mode ? getpid() != 1 || getuid() != 0 : getuid() != 1000 || geteuid() != 1000 || getppid() != 1) return 77;
    if (load_uuid("/run/run-id", run_id) || load_uuid("/run/fs-uuid", fs_uuid) || load_uuid("/run/hash-seed", hash_seed)) return 65;
    return bootstrap_mode ? bootstrap_f2() : !strcmp(argv[1], "p1") ? collect_p1() : metadata();
}

#endif
