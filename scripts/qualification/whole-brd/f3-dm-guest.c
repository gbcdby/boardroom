/* 独立 DM-linear guest。旧 F3/F2 仅提供未选中的旧入口与设备无关原语。 */
#define F3_PURE_TEST 1
#include "f3-guest.c"
#include "f3-dm-uapi.h"
#include <ctype.h>
#include <limits.h>
#include <stdarg.h>

#define DM_NODE "/dev/boardroom-f3-dm"
#define DM_CONTROL "/dev/boardroom-f3-dm-control"
static dev_t dm_device;
static char dm_name[128], dm_uuid[129], dm_sysname[32], dm_resolved[PATH_MAX];
static struct stat dm_node, dm_control_node, dm_sys;
static bool dm_created, dm_identity_known, dm_control_exists, dm_node_exists, dm_close_unknown;
static unsigned char dm_baseline[65536];
static size_t dm_baseline_size;
static size_t dm_last_length;

struct dm_text { char raw[30000]; size_t length; int error; };
static void dm_text_add(struct dm_text *out, const char *format, ...) {
    if (out->error) return;
    va_list args; va_start(args, format);
    int n = vsnprintf(out->raw + out->length, sizeof(out->raw) - out->length, format, args);
    va_end(args);
    if (n < 0 || (size_t)n >= sizeof(out->raw) - out->length) out->error = EFBIG;
    else out->length += (size_t)n;
}
static void dm_text_hex(struct dm_text *out, const void *raw, size_t length) {
    const unsigned char *data = raw;
    if (length > (sizeof(out->raw) - out->length) / 2) { out->error = EFBIG; return; }
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < length; i++) {
        out->raw[out->length++] = hex[data[i] >> 4]; out->raw[out->length++] = hex[data[i] & 15];
    }
}
static void dm_text_stat(struct dm_text *out, const struct stat *st) {
    dm_text_add(out, "{\"dev\":%ju,\"ino\":%ju,\"rdev\":%ju,\"mode\":%u,\"uid\":%u,\"gid\":%u,\"nlink\":%ju}",
        (uintmax_t)st->st_dev, (uintmax_t)st->st_ino, (uintmax_t)st->st_rdev,
        st->st_mode, st->st_uid, st->st_gid, (uintmax_t)st->st_nlink);
}
static int dm_close(int *fd) {
    if (*fd < 0) return 0;
    int saved = *fd; *fd = -1;
    int error = close(saved) ? errno : 0;
    if (error) dm_close_unknown = true;
    return error;
}
static bool dm_same_node(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_rdev == b->st_rdev
        && a->st_mode == b->st_mode && a->st_uid == b->st_uid && a->st_gid == b->st_gid && a->st_nlink == b->st_nlink;
}
static int dm_names(void) {
    if (strlen(run_id) != 36) return EINVAL;
    memcpy(dm_name, "br-f3-", 6); size_t n = 6;
    for (size_t i = 0; i < 36; i++) if (run_id[i] != '-') {
        if (!isxdigit((unsigned char)run_id[i]) || isupper((unsigned char)run_id[i])) return EINVAL;
        dm_name[n++] = run_id[i];
    }
    if (n != 38) return EINVAL;
    dm_name[n] = 0; snprintf(dm_uuid, sizeof(dm_uuid), "boardroom-f3-dm:%s", run_id);
    return 0;
}
static int dm_owned_open(const char *path, const struct stat *owned, int flags, mode_t type) {
    int fd = open(path, flags | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    struct stat held = {0}, named = {0}; int error = 0;
    if (fstat(fd, &held) || lstat(path, &named)) error = errno;
    if (!error && (!dm_same_node(owned, &held) || !dm_same_node(owned, &named)
        || held.st_mode != (type | 0600) || held.st_uid || held.st_gid || held.st_nlink != 1)) error = ESTALE;
    if (error) { int ce = dm_close(&fd); errno = error ? error : ce; return -1; }
    return fd;
}
static int dm_device_open(void) { return dm_owned_open(DM_NODE, &dm_node, O_RDONLY | O_NONBLOCK, S_IFBLK); }
static bool dm_fixed_string(const char *actual, size_t capacity, const char *expected) {
    size_t n = strlen(expected);
    if (n >= capacity || memcmp(actual, expected, n) || actual[n]) return false;
    for (size_t i = n + 1; i < capacity; i++) if (actual[i]) return false;
    return true;
}
static int dm_ioctl_call(const char *operation, const char *phase, unsigned long command) {
    union { max_align_t align; unsigned char raw[BR_DM_BUFFER_BYTES]; } buffer = {0};
    struct br_dm_ioctl *p = (void *)buffer.raw;
    p->version[0] = 4; p->version[1] = 50; p->data_size = sizeof(buffer.raw); p->data_start = sizeof(*p);
    if (command == BR_DM_CREATE) memcpy(p->name, dm_name, strlen(dm_name));
    if (command != BR_DM_VERSION && command != BR_DM_LIST) memcpy(p->uuid, dm_uuid, strlen(dm_uuid));
    if (command == BR_DM_TABLE) p->flags = BR_DM_TABLE_FLAG;
    if (command == BR_DM_LOAD) {
        p->target_count = 1;
        struct br_dm_target_spec *target = (void *)(buffer.raw + p->data_start);
        target->length = 131072; target->next = 48; memcpy(target->target_type, "linear", 6);
        memcpy((unsigned char *)target + sizeof(*target), "1:0 0", 6);
    }
    int fd = dm_owned_open(DM_CONTROL, &dm_control_node, O_RDWR | O_NONBLOCK, S_IFCHR), error = fd < 0 ? errno : 0;
    int rc = -1;
    if (!error) { errno = 0; rc = ioctl(fd, command, buffer.raw); if (rc) error = rc < 0 && errno ? errno : EPROTO; }
    if (!error && command == BR_DM_CREATE) dm_created = true;
    if (!error && (p->version[0] != 4 || p->version[1] != 50 || p->version[2]
        || p->data_start != sizeof(*p) || p->padding || p->open_count < 0
        || p->data_size < offsetof(struct br_dm_ioctl, data) || p->data_size > sizeof(buffer.raw))) error = EPROTO;
    if (!error && command == BR_DM_VERSION) {
        if (p->data_size != sizeof(buffer.raw) || p->target_count || p->open_count || p->flags || p->event_nr || p->dev
            || !dm_fixed_string(p->name, sizeof(p->name), "") || !dm_fixed_string(p->uuid, sizeof(p->uuid), "")) error = EPROTO;
        for (size_t i = 305; !error && i < sizeof(buffer.raw); i++) if (buffer.raw[i]) error = EPROTO;
    } else if (!error && command == BR_DM_LIST) {
        if (p->data_size != sizeof(*p) || p->flags || p->target_count || p->open_count || p->event_nr
            || p->dev || !dm_fixed_string(p->name, sizeof(p->name), "") || !dm_fixed_string(p->uuid, sizeof(p->uuid), "")) error = EPROTO;
    } else if (!error && command != BR_DM_VERSION) {
        if (!dm_fixed_string(p->name, sizeof(p->name), dm_name) || !dm_fixed_string(p->uuid, sizeof(p->uuid), dm_uuid)) error = ESTALE;
        if (!error && command == BR_DM_CREATE) {
            if (!p->dev || p->dev >= (1ULL << 32) || p->dev == 256 || p->flags || p->target_count
                || p->data_size != 305) error = EPROTO;
            else { dm_device = (dev_t)p->dev; dm_identity_known = major(dm_device) != 0; if (!dm_identity_known) error = EPROTO; }
        } else if (!error && command == BR_DM_REMOVE) {
            if (p->dev || p->target_count || p->data_size != 305 || (p->flags && p->flags != BR_DM_UEVENT)) error = EPROTO;
            else dm_created = false;
        } else if (!error) {
            unsigned required = command == BR_DM_LOAD ? BR_DM_INACTIVE : BR_DM_ACTIVE | (command == BR_DM_TABLE ? BR_DM_TABLE_FLAG : 0);
            unsigned actual = p->flags;
            if (command == BR_DM_RESUME) actual &= ~BR_DM_UEVENT;
            if (!dm_identity_known || p->dev != (uint64_t)dm_device || actual != required
                || p->target_count != (command == BR_DM_LOAD ? 0U : 1U)) error = EPROTO;
            if (!error && command == BR_DM_TABLE) {
                struct br_dm_target_spec *t = (void *)(buffer.raw + sizeof(*p));
                if (p->data_size != sizeof(*p) + 46 || t->sector_start || t->length != 131072 || t->status || t->next != 48
                    || !dm_fixed_string(t->target_type, sizeof(t->target_type), "linear")
                    || memcmp((unsigned char *)t + sizeof(*t), "1:0 0", 6)) error = EPROTO;
            } else if (!error && command == BR_DM_DEPS) {
                struct br_dm_target_deps *d = (void *)(buffer.raw + sizeof(*p));
                if (p->data_size != sizeof(*p) + 16 || d->count != 1 || d->padding || d->dev[0] != 256) error = EPROTO;
            } else if (!error && p->data_size != 305) error = EPROTO;
        }
    }
    if (command == BR_DM_LIST || command == BR_DM_TABLE || command == BR_DM_DEPS)
        for (size_t i = 305; !error && i < sizeof(*p); i++) if (buffer.raw[i]) error = EPROTO;
    int ce = dm_close(&fd);
    size_t length = p->data_size >= 305 && p->data_size <= sizeof(buffer.raw) ? p->data_size : 305;
    char event_name[40]; snprintf(event_name, sizeof(event_name), "dm-%s", operation);
    int emitted = f3_event(event_name, phase, error, ce, buffer.raw, length);
    return error ? error : ce ? ce : emitted;
}
static int dm_read_value(struct dm_text *out, const char *name, const char *path, bool directory, bool absent) {
    struct observation observed = {0};
    if (absent) {
        struct stat st = {0};
        if (lstat(path, &st)) { observed.error = errno; observed.eof = true; }
        else observed.eof = true;
    } else observed = directory ? enumerate(path, false) : read_file(path, 4096);
    dm_last_length = observed.length;
    int error = observed.error == ENOENT && absent ? 0 : observed.error;
    if (!error && (observed.close_error || !observed.eof || (absent && observed.error != ENOENT)))
        error = observed.close_error ? observed.close_error : EPROTO;
    dm_text_add(out, "{\"name\":\"%s\",\"errno\":%d,\"close_errno\":%d,\"hex\":\"", name, observed.error, observed.close_error);
    dm_text_hex(out, bytes, observed.length); dm_text_add(out, "\"}");
    return error ? error : out->error;
}
static bool dm_names_equal(const unsigned char *actual, size_t length, const unsigned char *expected, size_t size) {
    if (length != size) return false;
    for (size_t at = 0; at < length;) {
        const unsigned char *end = memchr(actual + at, 0, length - at);
        if (!end || end == actual + at) return false;
        size_t n = (size_t)(end - actual - at) + 1, matches = 0;
        for (size_t off = 0; off < size;) {
            const unsigned char *last = memchr(expected + off, 0, size - off);
            if (!last || last == expected + off) return false;
            size_t m = (size_t)(last - expected - off) + 1;
            if (m == n && !memcmp(actual + at, expected + off, n)) matches++;
            off += m;
        }
        if (matches != 1) return false;
        for (size_t off = at + n; off < length;) {
            const unsigned char *last = memchr(actual + off, 0, length - off);
            if (!last) return false;
            size_t m = (size_t)(last - actual - off) + 1;
            if (m == n && !memcmp(actual + at, actual + off, n)) return false;
            off += m;
        }
        at += n;
    }
    return true;
}
static int dm_resolve(void) {
    char path[128]; snprintf(path, sizeof(path), "/sys/dev/block/%u:%u", major(dm_device), minor(dm_device));
    if (!realpath(path, dm_resolved)) return errno;
    static const char prefix[] = "/sys/devices/virtual/block/";
    if (strncmp(dm_resolved, prefix, sizeof(prefix) - 1)) return ESTALE;
    const char *name = dm_resolved + sizeof(prefix) - 1;
    if (strncmp(name, "dm-", 3) || !name[3] || strlen(name) >= sizeof(dm_sysname)) return EPROTO;
    for (const char *p = name + 3; *p; p++) if (!isdigit((unsigned char)*p)) return EPROTO;
    strcpy(dm_sysname, name);
    if (stat(dm_resolved, &dm_sys) || !S_ISDIR(dm_sys.st_mode)) return errno ? errno : EPROTO;
    return 0;
}
static int dm_topology(const char *phase) {
    int error = dm_ioctl_call("status", phase, BR_DM_STATUS);
    if (!error) error = dm_ioctl_call("table", phase, BR_DM_TABLE);
    if (!error) error = dm_ioctl_call("deps", phase, BR_DM_DEPS);
    if (error) return error;
    struct dm_text out = {0}; struct stat current = {0};
    if (stat(dm_resolved, &current)) error = errno;
    if (!error && (current.st_dev != dm_sys.st_dev || current.st_ino != dm_sys.st_ino)) error = ESTALE;
    dm_text_add(&out, "{\"sysname\":\"%s\",\"resolved\":\"%s\",\"sys_dev\":%ju,\"sys_ino\":%ju,\"node\":",
        dm_sysname, dm_resolved, (uintmax_t)current.st_dev, (uintmax_t)current.st_ino);
    int fd = dm_device_open(); if (fd < 0 && !error) error = errno;
    uint64_t size = 0; struct stat st = {0};
    if (fd >= 0 && (fstat(fd, &st) || ioctl(fd, BLKGETSIZE64, &size)) && !error) error = errno;
    dm_text_stat(&out, &st); dm_text_add(&out, ",\"size\":%"PRIu64",\"control\":", size); dm_text_stat(&out, &dm_control_node);
    if (!error && size != 67108864) error = EPROTO;
    int ce = dm_close(&fd);
    dm_text_add(&out, ",\"reads\":[");
    static const struct { const char *key, *suffix; bool directory, absent; } fields[] = {
        {"dev", "dev", false, false}, {"size", "size", false, false}, {"ro", "ro", false, false},
        {"iostats", "queue/iostats", false, false}, {"name", "dm/name", false, false}, {"uuid", "dm/uuid", false, false},
        {"holders", "holders", true, false}, {"slaves", "slaves", true, false}, {"partition", "partition", false, true}
    };
    for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); i++) {
        if (i) dm_text_add(&out, ",");
        char path[PATH_MAX + 64]; snprintf(path, sizeof(path), "%s/%s", dm_resolved, fields[i].suffix);
        int e = dm_read_value(&out, fields[i].key, path, fields[i].directory, fields[i].absent); if (e && !error) error = e;
        if (!error && !fields[i].absent) {
            char expected[256]; size_t size = 0;
            if (i == 0) { int n = snprintf(expected, sizeof(expected), "%u:%u\n", major(dm_device), minor(dm_device)); size = (size_t)n; }
            else if (i == 1) { memcpy(expected, "131072\n", 7); size = 7; }
            else if (i == 2 || i == 3) { memcpy(expected, i == 2 ? "0\n" : "1\n", 2); size = 2; }
            else if (i == 4 || i == 5) { int n = snprintf(expected, sizeof(expected), "%s\n", i == 4 ? dm_name : dm_uuid); size = (size_t)n; }
            else if (i == 7) { memcpy(expected, "ram0", 5); size = 5; }
            if (dm_last_length != size || memcmp(bytes, expected, size)) error = EPROTO;
        }
    }
    static const struct { const char *key, *path; bool directory, absent; } other[] = {
        {"ram-holders", "/sys/block/ram0/holders", true, false}, {"ram-slaves", "/sys/block/ram0/slaves", true, false},
        {"ram-partition", "/sys/block/ram0/partition", false, true}, {"sys-block", "/sys/block", true, false},
        {"ram-node", "/dev/ram0", false, true}
    };
    for (size_t i = 0; i < sizeof(other) / sizeof(other[0]); i++) {
        dm_text_add(&out, ","); int e = dm_read_value(&out, other[i].key, other[i].path, other[i].directory, other[i].absent);
        if (e && !error) error = e;
        if (!error && i == 0 && (dm_last_length != strlen(dm_sysname) + 1 || memcmp(bytes, dm_sysname, dm_last_length))) error = EPROTO;
        if (!error && i == 1 && dm_last_length) error = EPROTO;
        if (!error && i == 3) {
            unsigned char expected[65536]; size_t n = strlen(dm_sysname) + 1;
            if (dm_baseline_size + 5 + n > sizeof(expected)) error = EFBIG;
            else {
                memcpy(expected, dm_baseline, dm_baseline_size); memcpy(expected + dm_baseline_size, "ram0", 5);
                memcpy(expected + dm_baseline_size + 5, dm_sysname, n);
                if (!dm_names_equal(bytes, dm_last_length, expected, dm_baseline_size + 5 + n)) error = EPROTO;
            }
        }
    }
    dm_text_add(&out, "]}"); if (out.error && !error) error = out.error;
    int emitted = f3_event("dm-topology", phase, error, ce, out.raw, out.length);
    return error ? error : ce ? ce : emitted;
}

static int dm_calibration_stat(unsigned char out[4096], size_t *length) {
    char path[PATH_MAX + 8]; snprintf(path, sizeof(path), "%s/stat", dm_resolved);
    struct observation o = read_file(path, 4096);
    if (o.error || o.close_error || !o.eof) return o.error ? o.error : o.close_error ? o.close_error : EIO;
    memcpy(out, bytes, o.length); *length = o.length; return 0;
}
static int dm_stat_values(const unsigned char *raw, size_t length, uint64_t values[17]) {
    if (!length || length >= 4096 || raw[length - 1] != '\n') return EPROTO;
    char copy[4096]; memcpy(copy, raw, length); copy[length] = 0; char *at = copy;
    for (unsigned i = 0; i < 17; i++) {
        while (*at == ' ' || *at == '\t') at++;
        if (!isdigit((unsigned char)*at)) return EPROTO;
        char *end = NULL; errno = 0; values[i] = strtoull(at, &end, 10);
        if (errno || !end || end == at || (*end != ' ' && *end != '\t' && *end != '\n')) return EPROTO;
        at = end;
    }
    while (*at == ' ' || *at == '\t') at++;
    return at[0] == '\n' && at[1] == 0 && values[8] == 0 ? 0 : EPROTO;
}
static int dm_calibrate(void) {
    /* 不插入第五次全设备观察；五个同步 4KiB 操作全部位于 mkfs 之前。 */
    int fd = dm_owned_open(DM_NODE, &dm_node, O_RDWR | O_DIRECT, S_IFBLK), error = fd < 0 ? errno : 0;
    int saved = fd, flags = fd >= 0 ? fcntl(fd, F_GETFL) : -1;
    if (flags < 0 && !error) error = errno;
    if (!error && ((flags & (O_ACCMODE | O_DIRECT)) != (O_RDWR | O_DIRECT)
        || (flags & ~(O_ACCMODE | O_DIRECT | 0x8000 | O_NOFOLLOW)))) error = EPROTO;
    char iostat_path[PATH_MAX + 32]; snprintf(iostat_path, sizeof(iostat_path), "%s/queue/iostats", dm_resolved);
    struct observation initial = read_file(iostat_path, 32);
    if (!error && (initial.error || initial.close_error || !initial.eof || initial.length != 2 || memcmp(bytes, "1\n", 2)))
        error = initial.error ? initial.error : initial.close_error ? initial.close_error : EPROTO;
    unsigned char *a = NULL, *b = NULL, *readback = NULL;
    int e = posix_memalign((void **)&a, 4096, 4096); if (e && !error) error = e;
    e = posix_memalign((void **)&b, 4096, 4096); if (e && !error) error = e;
    e = posix_memalign((void **)&readback, 4096, 4096); if (e && !error) error = e;
    if (b) memset(b, 0xa5, 4096);
    const char *names[] = {"read-original", "write-pattern", "read-pattern", "restore-original", "read-restored"};
    uint64_t previous[17] = {0};
    for (unsigned i = 0; !error && i < 5; i++) {
        unsigned char before[4096], after[4096]; size_t bl = 0, al = 0;
        error = dm_calibration_stat(before, &bl);
        uint64_t bv[17] = {0}, av[17] = {0};
        if (!error) error = dm_stat_values(before, bl, bv);
        if (!error && i && memcmp(previous, bv, sizeof(previous))) error = EPROTO;
        unsigned char *data = i == 0 || i == 3 ? a : i == 1 ? b : readback;
        ssize_t rc = -1; int io_error = 0;
        if (!error) {
            rc = i == 1 || i == 3 ? pwrite(fd, data, 4096, 0) : pread(fd, data, 4096, 0);
            if (rc < 0) io_error = errno;
            if (rc != 4096) error = io_error ? io_error : EIO;
        }
        if (!error && ((i == 2 && memcmp(data, b, 4096)) || (i == 4 && memcmp(data, a, 4096)))) error = EPROTO;
        e = dm_calibration_stat(after, &al); if (e && !error) error = e;
        if (!error) error = dm_stat_values(after, al, av);
        bool writing = i == 1 || i == 3;
        for (unsigned j = 0; !error && j < 17; j++) {
            if (av[j] < bv[j]) { error = EPROTO; break; }
            uint64_t difference = av[j] - bv[j];
            if ((j == 0 && difference != (writing ? 0U : 1U)) || (j == 2 && difference != (writing ? 0U : 8U))
                || (j == 4 && difference != (writing ? 1U : 0U)) || (j == 6 && difference != (writing ? 8U : 0U))
                || ((j == 1 || j == 5 || j == 8 || j == 11 || j == 12 || j == 13 || j == 15) && difference)) error = EPROTO;
        }
        memcpy(previous, av, sizeof(previous));
        struct dm_text out = {0}; dm_text_add(&out, "{\"operation\":\"%s\",\"rc\":%zd,\"errno\":%d,\"data_hex\":\"", names[i], rc, io_error);
        if (rc == 4096) dm_text_hex(&out, data, 4096);
        dm_text_add(&out, "\",\"before_hex\":\""); dm_text_hex(&out, before, bl);
        dm_text_add(&out, "\",\"after_hex\":\""); dm_text_hex(&out, after, al); dm_text_add(&out, "\"}");
        if (out.error && !error) error = out.error;
        e = f3_event("dm-calibration-step", "calibration", error, 0, out.raw, out.length); if (e && !error) error = e;
    }
    free(a); free(b); free(readback);
    int ce = dm_close(&fd);
    char path[PATH_MAX + 32]; snprintf(path, sizeof(path), "%s/queue/iostats", dm_resolved);
    struct observation o = read_file(path, 32); if ((o.error || o.close_error || !o.eof) && !error) error = o.error ? o.error : o.close_error ? o.close_error : EIO;
    struct dm_text out = {0}; dm_text_add(&out, "{\"device\":%ju,\"fd\":%d,\"flags\":%d,\"close_errno\":%d,\"iostats_hex\":\"", (uintmax_t)dm_device, saved, flags, ce);
    dm_text_hex(&out, bytes, o.length); dm_text_add(&out, "\"}"); if (out.error && !error) error = out.error;
    e = f3_event("dm-calibration-end", "calibration", error, ce, out.raw, out.length);
    return error ? error : ce ? ce : e;
}

static int dm_census(const char *phase);
static char dm_proc_options[128];
static const char *dm_meta_path(const char *suffix) {
    static char path[PATH_MAX + 64];
    snprintf(path, sizeof(path), "%s/%s", dm_resolved, suffix);
    return path;
}

/* 以下为 profile 本地变体；旧 whole-ram0 函数及源文件不做替换。 */
static int dm_format_fds(int executable, const struct stat *owned);
static struct child_result dm_format_child(void) {
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
        if (dm_format_fds(executable, &ex)) _exit(125);
        char extended[256]; snprintf(extended, sizeof(extended),
            "lazy_itable_init=0,lazy_journal_init=0,nodiscard,assume_storage_prezeroed=0,hash_seed=%s", hash_seed);
        char *args[] = {"/usr/sbin/mke2fs", "-t", "ext4", "-T", "brd64", "-b", "4096", "-I", "256", "-i", "16384", "-m", "0",
            "-U", fs_uuid, "-J", "size=4", "-O", (char *)feature_list, "-E", extended, DM_NODE, "16384", NULL};
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
    double deadline = monotonic() + 30.0; bool killed = false, no_waitable_child = false; int status = 0;
    while (!r.reaped || !eof[0] || !eof[1]) {
        if (!r.reaped) {
            pid_t done = waitpid(r.pid, &status, WNOHANG);
            if (done == r.pid) r.reaped = true;
            else if (done < 0) {
                int error = errno;
                if (error == ECHILD) no_waitable_child = true;
                if (error != EINTR && !r.error) r.error = error;
            }
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
        double now = monotonic();
        if (!killed && !r.reaped && (r.error || r.close_error || output_error || now >= deadline)) {
            r.timed_out = now >= deadline;
            int kr = kill_owned_child(r.pid, pidfd, no_waitable_child);
            if (kr && errno != ESRCH && !r.error) r.error = errno;
            killed = true; deadline = monotonic() + 2.0;
        }
        if (now >= deadline && (!r.reaped || !eof[0] || !eof[1])) { if (!r.error) r.error = ETIMEDOUT; break; }
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

static int dm_raw_metadata(const char *stage) {
    int fd = dm_device_open(), error = fd < 0 ? errno : 0;
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

static int dm_metadata(void) {
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
    meta_file("device_dev", dm_meta_path("dev"), 4096);
    meta_file("device_size", dm_meta_path("size"), 4096);
    meta_file("device_logical", dm_meta_path("queue/logical_block_size"), 4096);
    meta_file("device_physical", dm_meta_path("queue/physical_block_size"), 4096);
    meta_file("device_ro", dm_meta_path("ro"), 4096);
    struct stat part = {0}; o = (struct observation){0};
    if (lstat(dm_meta_path("partition"), &part)) {
        o.error = errno; o.eof = true;
        if (o.error == ENOENT) { memcpy(bytes, "absent\n", 7); o.length = 7; }
    } else { memcpy(bytes, "present\n", 8); o.length = 8; o.eof = true; all_ok = false; }
    emit2("device_partition", dm_meta_path("partition"), o, o.error == ENOENT);
    o = enumerate(dm_meta_path("holders"), false); emit2("device_holders", dm_meta_path("holders"), o, false);
    o = enumerate(dm_meta_path("slaves"), false); emit2("device_slaves", dm_meta_path("slaves"), o, false);
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
        meta_file("effective_options", dm_proc_options, 16384);
        static const char *health[] = {"errors_count", "first_error_errcode", "last_error_errcode", "first_error_ino", "last_error_ino",
            "first_error_block", "last_error_block", "first_error_line", "last_error_line", "first_error_time", "last_error_time",
            "first_error_func", "last_error_func"};
        for (size_t i = 0; i < sizeof(health) / sizeof(health[0]); ++i) {
            char path[128], item[64]; snprintf(path, sizeof(path), "/sys/fs/ext4/%s/%s", dm_sysname, health[i]);
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

static int dm_snapshot(const char *phase) {
    int fd = dm_device_open(), error = fd < 0 ? errno : 0, ce = 0;
    struct stat before = {0}, after = {0}, path = {0}; uint64_t size = 0;
    if (!error && fstat(fd, &before)) error = errno;
    if (!error && (before.st_mode != (S_IFBLK | 0600) || before.st_nlink != 1)) error = EPROTO;
    if (!error && ioctl(fd, BLKGETSIZE64, &size)) error = errno;
    if (!error && size != 64U * 1024U * 1024U) error = EPROTO;
    int saved = fd; char text[768];
    uint64_t begin = f3_now(CLOCK_MONOTONIC, &error);
    int n = f3_binding(text, sizeof(text), saved, &before, begin, false);
    int emitted = f3_event("snapshot-begin", phase, error, 0, text, (size_t)n);
    if (!error) error = emitted;
    if (!error) error = f3_stream_blocks(phase, fd);
    if (fd >= 0) {
        if (fstat(fd, &after) && !error) error = errno;
        if (lstat(DM_NODE, &path) && !error) error = errno;
        /* This is the owned device node, not an application source inode.
           Its access time may reflect our actual pread; bind structural identity. */
        if ((before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
             before.st_rdev != after.st_rdev || before.st_mode != after.st_mode ||
             before.st_uid != after.st_uid || before.st_gid != after.st_gid ||
             before.st_nlink != after.st_nlink || before.st_size != after.st_size ||
             before.st_dev != path.st_dev || before.st_ino != path.st_ino ||
             before.st_rdev != path.st_rdev || before.st_mode != path.st_mode ||
             before.st_uid != path.st_uid || before.st_gid != path.st_gid ||
             before.st_nlink != path.st_nlink) && !error) error = ESTALE;
    }
    ce = close_once(&fd);
    uint64_t end = f3_now(CLOCK_MONOTONIC, &error);
    n = f3_binding(text, sizeof(text), saved, &after, end, ce == 0 && saved >= 0);
    emitted = f3_event("snapshot-end", phase, error, ce, text, (size_t)n);
    return error ? error : ce ? ce : emitted;
}

static int dm_raw_superblock(const char *phase) {
    int fd = dm_device_open(), error = fd < 0 ? errno : 0;
    unsigned char raw[1024] = {0};
    if (!error) error = read_at(fd, raw, sizeof(raw), 1024);
    int ce = close_once(&fd), emitted = f3_event("mount-base", phase, error, ce, raw, sizeof(raw));
    return error ? error : ce ? ce : emitted;
}

static int dm_statistics(const char *phase, const char *event_name) {
    struct observation o = read_file(dm_meta_path("stat"), 4096);
    int error = o.error ? o.error : o.close_error ? o.close_error : !o.eof ? EIO : 0;
    char text[10000]; size_t at = 0;
    uint64_t mono = f3_now(CLOCK_MONOTONIC, &error), real = f3_now(CLOCK_REALTIME, &error);
    int n = snprintf(text, sizeof(text), "{\"monotonic_ns\":\"%"PRIu64"\",\"realtime_ns\":\"%"PRIu64"\",\"raw_hex\":\"", mono, real);
    if (n < 0 || (size_t)n + 2U * o.length + 4U > sizeof(text)) return EFBIG;
    at = (size_t)n; static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < o.length; ++i) { text[at++] = hex[bytes[i] >> 4]; text[at++] = hex[bytes[i] & 15]; }
    memcpy(text + at, "\"}", 2); at += 2;
    int emitted = f3_event(event_name, phase, error, o.close_error, text, at);
    return error ? error : emitted;
}

static int dm_object_view(const char *phase, int root, const char *name) {
    int fd = openat(root, name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    int error = fd < 0 ? errno : 0, ce = 0;
    struct stat first = {0}, held = {0}, path = {0};
    if (!error && fstat(fd, &first)) error = errno;
    bool payload = !strcmp(name, "payload"), lost_found = !strcmp(name, "lost+found");
    if (!error && (first.st_dev != dm_device || (payload ? !S_ISREG(first.st_mode) || first.st_nlink != 1 : !S_ISDIR(first.st_mode)) ||
        (!lost_found && (first.st_uid != 1000 || first.st_gid != 1000 || (first.st_mode & 07777) != (payload ? 0600 : 0700))) ||
        (lost_found && (first.st_uid || first.st_gid)))) error = EPROTO;
    char text[1024]; int n = snprintf(text, sizeof(text),
        "{\"name\":\"%s\",\"fd\":%d,\"dev\":%ju,\"ino\":%ju,\"mode\":%u,\"uid\":%u,\"gid\":%u,\"nlink\":%ju,\"size\":%jd,"
        "\"atime\":[%jd,%ld],\"mtime\":[%jd,%ld],\"ctime\":[%jd,%ld]}",
        name, fd, (uintmax_t)first.st_dev, (uintmax_t)first.st_ino, first.st_mode, first.st_uid, first.st_gid,
        (uintmax_t)first.st_nlink, (intmax_t)first.st_size, (intmax_t)first.st_atim.tv_sec, first.st_atim.tv_nsec,
        (intmax_t)first.st_mtim.tv_sec, first.st_mtim.tv_nsec, (intmax_t)first.st_ctim.tv_sec, first.st_ctim.tv_nsec);
    int emitted = f3_event("view-object", phase, error, 0, text, (size_t)n);
    if (!error) error = emitted;
    char full[256]; snprintf(full, sizeof(full), "/mnt/brd/%s", name);
    char names[4096]; ssize_t length = -1; size_t total = 0; unsigned count = 0;
    if (!error) { length = llistxattr(full, names, sizeof(names)); if (length < 0) error = errno; }
    for (size_t pos = 0; !error && pos < (size_t)length;) {
        char *end = memchr(names+pos, 0, (size_t)length-pos);
        if (!end || end == names+pos || ++count > 64) { error = EPROTO; break; }
        size_t name_len = (size_t)(end-(names+pos)); unsigned char value[16384], raw[16645];
        if (name_len > 255) { error = EFBIG; break; }
        ssize_t size = lgetxattr(full, names+pos, value, sizeof(value));
        if (size < 0) { error = errno; break; }
        total += name_len+(size_t)size; if (total > 65536) { error = EFBIG; break; }
        uint16_t nl = (uint16_t)name_len; uint32_t vl = (uint32_t)size;
        memcpy(raw, &nl, 2); memcpy(raw+2, &vl, 4);
        memcpy(raw+6, names+pos, name_len); memcpy(raw+6+name_len, value, (size_t)size);
        error = f3_event("view-attr", phase, 0, 0, raw, 6+name_len+(size_t)size);
        pos += name_len+1;
    }
    if (!error && S_ISDIR(first.st_mode) && strcmp(name, ".")) error = f3_members(phase, fd);
    if (!error && !strcmp(name, "ancestor")) {
        struct stat missing = {0}; errno = 0;
        int rc = fstatat(fd, "missing", &missing, AT_SYMLINK_NOFOLLOW), actual = rc ? errno : 0;
        if (rc != -1 || actual != ENOENT) error = EEXIST;
        n = snprintf(text, sizeof(text), "{\"path\":\"ancestor/missing\",\"ancestor_fd\":%d,\"dev\":%ju,\"ino\":%ju,\"errno\":%d}",
            fd, (uintmax_t)first.st_dev, (uintmax_t)first.st_ino, actual);
        emitted = f3_event("view-absence", phase, error, 0, text, (size_t)n); if (!error) error = emitted;
    }
    if (fd >= 0) {
        if ((fstat(fd, &held) || fstatat(root, name, &path, AT_SYMLINK_NOFOLLOW)) && !error) error = errno;
        if ((!f3_same_stat(&first, &held) || !f3_same_stat(&first, &path)) && !error) error = ESTALE;
    }
    ce = f3_close_view(phase, name, &fd);
    return error ? error : ce;
}

static int dm_source_view(const char *phase) {
    int root = open("/mnt/brd", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int error = root < 0 ? errno : 0; struct stat before = {0}, after = {0}, path = {0};
    if (!error && fstat(root, &before)) error = errno;
    if (!error && (before.st_dev != dm_device || before.st_ino != 2 ||
        before.st_mode != (S_IFDIR | 0700) || before.st_uid != 1000 || before.st_gid != 1000)) error = EPROTO;
    char text[256]; int n = snprintf(text, sizeof(text),
        "{\"root_fd\":%d,\"dev\":%ju,\"ino\":%ju,\"object_count\":5,\"ordinary_source_open_count\":0}",
        root, (uintmax_t)before.st_dev, (uintmax_t)before.st_ino);
    int emitted = f3_event("view-begin", phase, error, 0, text, (size_t)n);
    if (!error) error = emitted;
    if (!error) error = f3_members(phase, root);
    const char *names[] = {".", "payload", "directory", "ancestor", "lost+found"};
    for (unsigned i = 0; !error && i < 5; ++i) error = dm_object_view(phase, root, names[i]);
    if (root >= 0) {
        if ((fstat(root, &after) || lstat("/mnt/brd", &path)) && !error) error = errno;
        if ((!f3_same_stat(&before, &after) || !f3_same_stat(&before, &path)) && !error) error = ESTALE;
    }
    int ce = f3_close_view(phase, "root", &root);
    emitted = f3_event("view-end", phase, error, ce, text, (size_t)n);
    return error ? error : ce ? ce : emitted;
}

static int dm_prepare_objects(void) {
    int root = open("/mnt/f3-prepare", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NOATIME | O_CLOEXEC);
    int error = root < 0 ? errno : 0, fd = -1, cleanup = 0;
    struct stat source = {0};
    if (!error && fstat(root, &source)) error = errno;
    if (!error && (source.st_dev != dm_device || source.st_ino != 2)) error = EPROTO;
    if (!error && (fchown(root,1000,1000) || fchmod(root,0700))) error = errno;
    static const char attr[] = "user.boardroom-source-preservation", value[] = "owned-fixture";
    if (!error && fsetxattr(root,attr,value,sizeof(value)-1,0)) error = errno;
    const char *directories[] = {"directory","ancestor"};
    for (unsigned i = 0; !error && i < 2; ++i) {
        if (mkdirat(root,directories[i],0700)) { error = errno; break; }
        fd = openat(root,directories[i],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NOATIME|O_CLOEXEC);
        if (fd < 0) error = errno;
        if (!error && (fchown(fd,1000,1000) || fchmod(fd,0700) ||
            fsetxattr(fd,attr,value,sizeof(value)-1,0) || fsync(fd))) error = errno;
        int ce = close_once(&fd); if (ce && !cleanup) cleanup = ce;
    }
    if (!error && !cleanup) {
        fd = openat(root,"payload",O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
        if (fd < 0) error = errno;
        if (!error) {
            ssize_t written = write(fd,F3_EXPECTED_PAYLOAD,sizeof(F3_EXPECTED_PAYLOAD));
            if (written < 0) error = errno;
            else if (written != (ssize_t)sizeof(F3_EXPECTED_PAYLOAD)) error = EIO;
        }
        if (!error && (fchown(fd,1000,1000) || fchmod(fd,0600) ||
            fsetxattr(fd,attr,value,sizeof(value)-1,0) || fsync(fd))) error = errno;
        int ce = close_once(&fd); if (ce && !cleanup) cleanup = ce;
    }
    if (!error && !cleanup && fsync(root)) error = errno;
    { int ce = close_once(&fd); if (ce && !cleanup) cleanup = ce; }
    { int ce = close_once(&root); if (ce && !cleanup) cleanup = ce; }
    int emitted = f3_event("prepare-objects","prepare",error,cleanup,F3_EXPECTED_PAYLOAD,sizeof(F3_EXPECTED_PAYLOAD));
    return error ? error : cleanup ? cleanup : emitted;
}

static int dm_mount_at(const char *path, const char *phase, bool *mounted) {
    int rc = mount(DM_NODE,path,"ext4",MS_NOSUID|MS_NODEV|MS_NOEXEC|MS_RELATIME,
                   "errors=remount-ro,data=ordered,acl,user_xattr,dax=never");
    int error = rc ? errno : 0; *mounted = rc == 0;
    int emitted = f3_event("mount",phase,error,0,path,strlen(path));
    return error ? error : emitted;
}

static int dm_unmount_at(const char *path, const char *phase, bool *mounted) {
    struct stat source = {0}; int error = 0;
    if (lstat(path,&source)) error = errno;
    else if (source.st_ino != 2 || source.st_dev != dm_device) error = ESTALE;
    if (!error) { if (umount2(path,0)) error = errno; else *mounted = false; }
    int emitted = f3_event("unmount",phase,error,0,path,strlen(path));
    return error ? error : emitted;
}

static int dm_native(const char *phase, bool reading, bool *children_done) {
    const char *mode = reading ? "ordinary" : "context";
    int error = f3_event("native-begin",phase,0,0,mode,strlen(mode));
    if (error) return error;
    struct child_result child = ordinary_child(mode);
    *children_done = child.pid <= 0 || child.reaped;
    if (!child_ok(child)) error = child.error ? child.error : child.close_error ? child.close_error : ECHILD;
    uint64_t joined = f3_now(CLOCK_MONOTONIC,&error);
    char text[768]; int n = snprintf(text,sizeof(text),
        "{\"pid\":%d,\"exit\":%d,\"signal\":%d,\"timeout\":%s,\"reaped\":%s,"
        "\"pidfd_before_ack\":%s,\"joined_ns\":\"%"PRIu64"\"}",
        child.pid,child.code,child.signal,child.timed_out?"true":"false",child.reaped?"true":"false",
        child.pidfd_before_ack?"true":"false",joined);
    int emitted = f3_event("native-end",phase,error,child.close_error,text,(size_t)n);
    return error ? error : emitted;
}

static int dm_round(const char *phase, bool reading, bool *mounted, bool *children_done) {
    const char *before = reading ? "read-before" : "control-before";
    const char *after = reading ? "read-after" : "control-after";
    int error = dm_topology(before);
    if (!error) error = dm_census(before);
    if (!error) error = f3_event("round-begin",phase,0,0,"",0);
    if (!error) error = dm_statistics(phase,"block-stat-before");
    if (!error) error = dm_raw_superblock(phase);
    if (!error) error = dm_mount_at("/mnt/brd",phase,mounted);
    if (!error) error = dm_statistics(phase,"block-stat-mounted");
    if (!error && !reading) {
        struct child_result child = ordinary_child("metadata");
        *children_done = child.pid <= 0 || child.reaped;
        if (!child_ok(child)) error = child.error ? child.error : child.close_error ? child.close_error : ECHILD;
        if (output_error && !error) error = EIO;
    }
    if (!error) error = dm_snapshot(before);
    if (!error) error = dm_source_view(before);
    if (!error) error = dm_native(phase,reading,children_done);
    if (!error) error = dm_source_view(after);
    if (!error) error = dm_unmount_at("/mnt/brd",phase,mounted);
    if (!error) error = dm_statistics(phase,"block-stat-after");
    if (!error) error = dm_snapshot(after);
    if (!error) error = dm_topology(after);
    if (!error) error = dm_census(after);
    int emitted = f3_event("round-end",phase,error,0,"",0);
    return error ? error : emitted;
}

/* 每个清单项均来自实际目录/FD，枚举器属于本次调用，失败即停止该 profile。 */
static int dm_stat_identity(const unsigned char *raw, size_t length, long expected, unsigned long long *start, unsigned long *flags) {
    if (!length || length > 8192 || raw[length - 1] != '\n') return EPROTO;
    char copy[8193]; memcpy(copy, raw, length); copy[length] = 0;
    char *end = strrchr(copy, ')'), *number_end = NULL;
    if (!end || end[1] != ' ' || strtol(copy, &number_end, 10) != expected || !number_end || *number_end != ' ') return EPROTO;
    char *save = NULL, *token = strtok_r(end + 2, " \n", &save); unsigned index = 0;
    *start = 0; *flags = 0;
    while (token) {
        if (index == 6 || index == 19) {
            char *tail = NULL; errno = 0; unsigned long long value = strtoull(token, &tail, 10);
            if (errno || !tail || *tail || token[0] < '0' || token[0] > '9') return EPROTO;
            if (index == 6) *flags = (unsigned long)value; else *start = value;
        }
        index++; token = strtok_r(NULL, " \n", &save);
    }
    return index >= 20 && *start > 0 ? 0 : EPROTO;
}
static int dm_read_stat(int pin, unsigned char raw[8193], size_t *length) {
    char path[80]; snprintf(path, sizeof(path), "/proc/self/fd/%d/stat", pin);
    struct observation o = read_file(path, 8192);
    if (o.error || o.close_error || !o.eof) return o.error ? o.error : o.close_error ? o.close_error : EIO;
    memcpy(raw, bytes, o.length); *length = o.length; return 0;
}
static int dm_fd_rows(struct dm_text *out, DIR *dir, int proc_enumerator, int pin, bool ordinary) {
    int error = 0; unsigned seen = 0; int enumfd = dirfd(dir);
    dm_text_add(out, "[");
    for (;;) {
        errno = 0; struct dirent *entry = readdir(dir);
        if (!entry) { if (errno && !error) error = errno; break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        char *end = NULL; errno = 0; long fd = strtol(entry->d_name, &end, 10);
        if (errno || !end || *end || fd < 0 || fd > INT_MAX || ++seen > 16) { error = EPROTO; break; }
        struct stat st = {0}; int flags = fcntl((int)fd, F_GETFL);
        if (flags < 0 || fstat((int)fd, &st)) { error = errno; break; }
        bool enumerator = fd == enumfd || (!ordinary && (fd == proc_enumerator || fd == pin));
        if ((!enumerator && (fd > 2 || !S_ISCHR(st.st_mode)
                || (st.st_rdev != makedev(5, 1) && st.st_rdev != makedev(1, 3))))
            || (enumerator && !S_ISDIR(st.st_mode))) { error = EPROTO; break; }
        if (seen > 1) dm_text_add(out, ",");
        dm_text_add(out, "{\"fd\":%ld,\"flags\":%d,\"stat\":", fd, flags); dm_text_stat(out, &st); dm_text_add(out, "}");
    }
    dm_text_add(out, "]");
    return error ? error : out->error;
}
static int dm_format_fds(int executable, const struct stat *owned) {
    DIR *dir = opendir("/proc/self/fd"); int error = dir ? 0 : errno, enumerator = dir ? dirfd(dir) : -1;
    struct dm_text out = {0}; unsigned count = 0;
    dm_text_add(&out, "{\"run_id\":\"%s\",\"origin\":\"format\",\"pid\":%d,\"uid\":%u,\"gid\":%u,"
        "\"executable_fd\":%d,\"executable_size\":%jd,\"enumerator\":%d,\"fds\":[",
        run_id, getpid(), getuid(), getgid(), executable, (intmax_t)owned->st_size, enumerator);
    if (dir) for (;;) {
        errno = 0; struct dirent *entry = readdir(dir);
        if (!entry) { if (errno && !error) error = errno; break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        char *end = NULL; errno = 0; long fd = strtol(entry->d_name, &end, 10);
        if (errno || !end || *end || fd < 0 || fd > INT_MAX || ++count > 5) { error = EPROTO; break; }
        struct stat st = {0}; int flags = fcntl((int)fd, F_GETFL), descriptor_flags = fcntl((int)fd, F_GETFD);
        if (flags < 0 || descriptor_flags < 0 || fstat((int)fd, &st)) { error = errno; break; }
        bool valid = fd == executable ? dm_same_node(&st, owned) && st.st_size == owned->st_size && descriptor_flags == FD_CLOEXEC
            : fd == enumerator ? S_ISDIR(st.st_mode) && descriptor_flags == FD_CLOEXEC
            : fd == 0 ? S_ISCHR(st.st_mode) && st.st_rdev == makedev(1, 3) && (flags & O_ACCMODE) == O_RDONLY && !descriptor_flags
            : (fd == 1 || fd == 2) && S_ISFIFO(st.st_mode) && (flags & O_ACCMODE) == O_WRONLY && !descriptor_flags;
        if (!valid) { error = EPROTO; break; }
        if (count > 1) dm_text_add(&out, ",");
        dm_text_add(&out, "{\"fd\":%ld,\"flags\":%d,\"fd_flags\":%d,\"stat\":", fd, flags, descriptor_flags);
        dm_text_stat(&out, &st); dm_text_add(&out, "}");
    }
    if (!error && count != 5) error = EPROTO;
    int ce = 0; if (dir && closedir(dir)) ce = errno;
    dm_text_add(&out, "],\"errno\":%d,\"close_errno\":%d}", error ? error : out.error, ce);
    if (printf("BRDDM-MKFS %.*s\n", (int)out.length, out.raw) < 0 || fflush(stdout) || ferror(stdout)) return EIO;
    return error ? error : out.error ? out.error : ce;
}
static int dm_process_record(const char *phase, long pid, int proc_enumerator) {
    char path[128]; snprintf(path, sizeof(path), "/proc/%ld", pid);
    int pin = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC), error = pin < 0 ? errno : 0;
    unsigned char before[8193], after[8193]; size_t bl = 0, al = 0;
    unsigned long long start = 0, after_start = 0; unsigned long flags = 0, after_flags = 0;
    struct stat st = {0}; struct statfs fs = {0};
    if (!error && (fstat(pin, &st) || fstatfs(pin, &fs))) error = errno;
    if (!error && (st.st_uid || (unsigned long)fs.f_type != 0x9fa0UL)) error = EPROTO;
    if (!error) error = dm_read_stat(pin, before, &bl);
    if (!error) error = dm_stat_identity(before, bl, pid, &start, &flags);
    if (!error && pid != 1 && !(flags & 0x00200000UL)) error = EPROTO;
    struct dm_text out = {0}; dm_text_add(&out, "{\"pid\":%ld,\"pin\":%d,\"proc_enumerator\":%d,\"before_hex\":\"", pid, pin, proc_enumerator);
    dm_text_hex(&out, before, bl); dm_text_add(&out, "\",\"fds\":");
    DIR *dir = NULL; int enumerator = -1;
    if (!error) {
        snprintf(path, sizeof(path), "/proc/self/fd/%d/fd", pin); dir = opendir(path);
        if (!dir) error = errno; else enumerator = dirfd(dir);
    }
    if (dir && pid == 1) error = dm_fd_rows(&out, dir, proc_enumerator, pin, false);
    else if (dir) {
        dm_text_add(&out, "[");
        for (;;) {
            errno = 0; struct dirent *entry = readdir(dir);
            if (!entry) { if (errno && !error) error = errno; break; }
            if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) { error = EPROTO; break; }
        }
        dm_text_add(&out, "]");
    } else dm_text_add(&out, "[]");
    int ce = 0;
    if (dir && closedir(dir)) { ce = errno; dm_close_unknown = true; }
    if (pin >= 0) {
        int e = dm_read_stat(pin, after, &al); if (e && !error) error = e;
        if (!error) error = dm_stat_identity(after, al, pid, &after_start, &after_flags);
        if (!error && (start != after_start || (pid != 1 && !(after_flags & 0x00200000UL)))) error = ESTALE;
    }
    int e = dm_close(&pin); if (e && !ce) ce = e;
    dm_text_add(&out, ",\"enumerator\":%d,\"after_hex\":\"", enumerator); dm_text_hex(&out, after, al); dm_text_add(&out, "\"}");
    if (out.error && !error) error = out.error;
    e = f3_event("dm-census-process", phase, error, ce, out.raw, out.length);
    return error ? error : ce ? ce : e;
}
static int dm_device_walk(const char *path, unsigned depth, unsigned *entries, struct dm_text *out, unsigned *nodes) {
    if (depth > 16) return EFBIG;
    DIR *dir = opendir(path); if (!dir) return errno;
    int error = 0;
    for (;;) {
        errno = 0; struct dirent *entry = readdir(dir);
        if (!entry) { if (errno && !error) error = errno; break; }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        if (++*entries > 256) { error = EFBIG; break; }
        char child[PATH_MAX]; int n = snprintf(child, sizeof(child), "%s%s%s", path, strcmp(path, "/") ? "/" : "", entry->d_name);
        if (n < 0 || (size_t)n >= sizeof(child)) { error = EFBIG; break; }
        struct stat st = {0}; if (lstat(child, &st)) { error = errno; break; }
        if (S_ISBLK(st.st_mode) || S_ISCHR(st.st_mode)) {
            bool valid = (!strcmp(child, DM_NODE) && dm_same_node(&st, &dm_node))
                || (!strcmp(child, DM_CONTROL) && dm_same_node(&st, &dm_control_node))
                || (!strcmp(child, "/dev/console") && S_ISCHR(st.st_mode) && st.st_rdev == makedev(5, 1) && st.st_nlink == 1)
                || (!strcmp(child, "/dev/null") && S_ISCHR(st.st_mode) && st.st_rdev == makedev(1, 3) && st.st_nlink == 1);
            if (!valid || ++*nodes > 4) { error = EPROTO; break; }
            if (*nodes > 1) dm_text_add(out, ",");
            dm_text_add(out, "{\"path\":\"%s\",\"stat\":", child); dm_text_stat(out, &st); dm_text_add(out, "}");
        } else if (S_ISDIR(st.st_mode) && strcmp(child, "/proc") && strcmp(child, "/sys")) {
            error = dm_device_walk(child, depth + 1, entries, out, nodes); if (error) break;
        }
    }
    if (closedir(dir)) { int e = errno; dm_close_unknown = true; if (!error) error = e; }
    return error ? error : out->error;
}
static int dm_unmounted_mounts(const unsigned char *raw, size_t length) {
    if (!length || length > 65536 || raw[length - 1] != '\n' || memchr(raw, 0, length)) return EPROTO;
    char copy[65537]; memcpy(copy, raw, length); copy[length] = 0;
    char *lines = NULL, *line = strtok_r(copy, "\n", &lines); unsigned found = 0, count = 0;
    while (line) {
        char *fields = NULL, *value = strtok_r(line, " ", &fields); unsigned column = 1, point = 0;
        while (value) {
            if (column == 5) {
                point = !strcmp(value, "/") ? 1U : !strcmp(value, "/proc") ? 2U : !strcmp(value, "/sys") ? 4U : 0U;
                break;
            }
            column++; value = strtok_r(NULL, " ", &fields);
        }
        if (!point || (found & point) || ++count > 3) return EPROTO;
        found |= point; line = strtok_r(NULL, "\n", &lines);
    }
    return found == 7 && count == 3 ? 0 : EPROTO;
}
static int dm_census(const char *phase) {
    int error = f3_event("dm-census-start", phase, 0, 0, "", 0), ce = 0; unsigned count = 0;
    DIR *proc = NULL;
    if (!error) { proc = opendir("/proc"); if (!proc) error = errno; }
    if (proc) for (;;) {
        errno = 0; struct dirent *entry = readdir(proc);
        if (!entry) { if (errno && !error) error = errno; break; }
        if (!isdigit((unsigned char)entry->d_name[0])) continue;
        char *end = NULL; long pid = strtol(entry->d_name, &end, 10);
        if (!end || *end || pid < 1 || pid > INT_MAX || ++count > 256) { error = EPROTO; break; }
        int e = dm_process_record(phase, pid, dirfd(proc)); if (e && !error) error = e;
        if (error) break;
    }
    if (proc && closedir(proc)) { ce = errno; dm_close_unknown = true; }
    struct dm_text out = {0}; dm_text_add(&out, "{\"process_count\":%u,\"nodes\":[", count);
    unsigned entries = 0, nodes = 0;
    if (!error) error = dm_device_walk("/", 0, &entries, &out, &nodes);
    if (!error && nodes != 4) error = EPROTO;
    dm_text_add(&out, "],\"mountinfo_hex\":\"");
    struct observation o = read_file("/proc/self/mountinfo", 65536);
    if ((o.error || o.close_error || !o.eof) && !error) error = o.error ? o.error : o.close_error ? o.close_error : EIO;
    if (!error) error = dm_unmounted_mounts(bytes, o.length);
    dm_text_hex(&out, bytes, o.length); dm_text_add(&out, "\"}"); if (out.error && !error) error = out.error;
    int e = f3_event("dm-census-end", phase, error, ce, out.raw, out.length);
    return error ? error : ce ? ce : e;
}
static int dm_ordinary_fds(void) {
    DIR *dir = opendir("/proc/self/fd"); int error = dir ? 0 : errno, enumerator = dir ? dirfd(dir) : -1;
    struct dm_text out = {0}; dm_text_add(&out, "{\"run_id\":\"%s\",\"origin\":\"ordinary\",\"pid\":%d,\"uid\":%u,\"gid\":%u,\"enumerator\":%d,\"fds\":", run_id, getpid(), getuid(), getgid(), enumerator);
    if (dir) error = dm_fd_rows(&out, dir, -1, -1, true); else dm_text_add(&out, "[]");
    int ce = 0; if (dir && closedir(dir)) ce = errno;
    dm_text_add(&out, ",\"errno\":%d,\"close_errno\":%d}", error ? error : out.error, ce);
    if (printf("BRDDM %.*s\n", (int)out.length, out.raw) < 0 || fflush(stdout) || ferror(stdout)) return EIO;
    return error ? error : out.error ? out.error : ce;
}
static int dm_load_source(void) {
    int fd = open("/mnt/brd", O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW), error = fd < 0 ? errno : 0;
    struct stat st = {0}; if (!error && fstat(fd, &st)) error = errno;
    if (!error && (st.st_ino != 2 || st.st_uid != 1000 || st.st_gid != 1000 || st.st_mode != (S_IFDIR | 0700))) error = EPROTO;
    if (!error) { dm_device = st.st_dev; error = dm_resolve(); }
    for (unsigned i = 0; !error && i < 2; i++) {
        const char *expected = i ? dm_uuid : dm_name;
        struct observation o = read_file(dm_meta_path(i ? "dm/uuid" : "dm/name"), 256);
        size_t n = strlen(expected);
        if (o.error || o.close_error || !o.eof || o.length != n + 1 || memcmp(bytes, expected, n) || bytes[n] != '\n')
            error = o.error ? o.error : o.close_error ? o.close_error : ESTALE;
    }
    int ce = dm_close(&fd); snprintf(dm_proc_options, sizeof(dm_proc_options), "/proc/fs/ext4/%s/options", dm_sysname);
    return error ? error : ce;
}

static int dm_backing_preflight(void) {
    struct dm_text out = {0}; dm_text_add(&out, "{\"reads\":[");
    const char *names[] = {"dev", "size", "ro", "holders", "slaves", "partition"};
    int error = 0;
    for (unsigned i = 0; i < 6; i++) {
        if (i) dm_text_add(&out, ",");
        char path[128]; snprintf(path, sizeof(path), "/sys/block/ram0/%s", names[i]);
        int e = dm_read_value(&out, names[i], path, i == 3 || i == 4, i == 5); if (e && !error) error = e;
        if (!error && i < 5) {
            const char *expected = i == 0 ? "1:0\n" : i == 1 ? "131072\n" : i == 2 ? "0\n" : "";
            if (dm_last_length != strlen(expected) || memcmp(bytes, expected, dm_last_length)) error = EPROTO;
        }
    }
    dm_text_add(&out, "]}"); if (out.error && !error) error = out.error;
    int e = f3_event("dm-backing", "setup", error, 0, out.raw, out.length);
    return error ? error : e;
}
static int dm_create_graph(bool *ram_node) {
    int error = dm_backing_preflight(); if (error) return error;
    struct stat prior = {0};
    if (lstat(DM_CONTROL, &prior) == 0 || errno != ENOENT) return EEXIST;
    struct observation o = read_file("/sys/class/misc/device-mapper/dev", 32);
    if (o.error || o.close_error || !o.eof || o.length != 7 || memcmp(bytes, "10:236\n", 7))
        return o.error ? o.error : o.close_error ? o.close_error : EPROTO;
    char target[PATH_MAX];
    if (!realpath("/sys/dev/char/10:236", target) || strcmp(target, "/sys/devices/virtual/misc/device-mapper")) return ESTALE;
    if (mknod(DM_CONTROL, S_IFCHR | 0600, makedev(10, 236))) return errno;
    dm_control_exists = true;
    if (lstat(DM_CONTROL, &dm_control_node)) return errno;
    if (dm_control_node.st_mode != (S_IFCHR | 0600) || dm_control_node.st_nlink != 1
        || dm_control_node.st_uid || dm_control_node.st_gid || dm_control_node.st_rdev != makedev(10, 236)) return EPROTO;
    struct dm_text control = {0}; dm_text_add(&control, "{\"sysfs_hex\":\"");
    dm_text_hex(&control, bytes, o.length);
    dm_text_add(&control, "\",\"resolved\":\"%s\",\"node\":", target);
    dm_text_stat(&control, &dm_control_node); dm_text_add(&control, "}");
    if (control.error) return control.error;
    error = f3_event("dm-control", "setup", 0, 0, control.raw, control.length);
    if (error) return error;
    error = dm_ioctl_call("version", "setup", BR_DM_VERSION);
    if (!error) error = dm_ioctl_call("list", "setup", BR_DM_LIST);
    if (!error) error = dm_ioctl_call("create", "setup", BR_DM_CREATE);
    if (!error) error = dm_ioctl_call("load", "setup", BR_DM_LOAD);
    if (!error) error = dm_ioctl_call("resume", "setup", BR_DM_RESUME);
    if (!error) error = dm_resolve();
    if (error) return error;
    if (lstat(DM_NODE, &prior) == 0 || errno != ENOENT) return EEXIST;
    if (mknod(DM_NODE, S_IFBLK | 0600, dm_device)) return errno;
    dm_node_exists = true;
    if (lstat(DM_NODE, &dm_node)) return errno;
    if (dm_node.st_mode != (S_IFBLK | 0600) || dm_node.st_nlink != 1 || dm_node.st_uid || dm_node.st_gid || dm_node.st_rdev != dm_device) return EPROTO;
    /* 此时原 geometry FD 已实际关闭；只删除自己创建且身份仍相同的原 ram0 节点。 */
    if (lstat("/dev/ram0", &prior) || !dm_same_node(&prior, &owned_node)) return ESTALE;
    if (unlink("/dev/ram0")) return errno;
    *ram_node = false;
    int absent = lstat("/dev/ram0", &prior) ? errno : 0;
    if (absent != ENOENT) return EPROTO;
    event("device-remove", 0, 0, 0, "", 0);
    struct dm_text out = {0}; dm_text_add(&out, "{\"node\":"); dm_text_stat(&out, &owned_node);
    dm_text_add(&out, ",\"after_errno\":%d}", absent);
    error = f3_event("dm-backing-retired", "setup", out.error, 0, out.raw, out.length);
    if (!error) error = dm_topology("created");
    if (!error) error = dm_census("created");
    if (!error) error = dm_calibrate();
    if (!error) error = dm_topology("calibrated");
    if (!error) error = dm_census("calibrated");
    return error;
}
static int dm_unlink_owned(const char *path, const struct stat *owned, bool *present) {
    struct stat actual = {0};
    if (lstat(path, &actual)) return errno;
    if (!dm_same_node(&actual, owned)) return ESTALE;
    if (unlink(path)) return errno;
    *present = false;
    return lstat(path, &actual) == -1 && errno == ENOENT ? 0 : EPROTO;
}
static int dm_remove_graph(void) {
    if (!dm_identity_known || dm_close_unknown || !dm_created || !dm_node_exists || !dm_control_exists) return EBUSY;
    int error = dm_topology("before-remove");
    if (!error) error = dm_census("before-remove");
    if (!error) error = dm_ioctl_call("remove", "cleanup", BR_DM_REMOVE);
    if (!error) error = dm_ioctl_call("list", "cleanup", BR_DM_LIST);
    struct stat st = {0}; char path[128];
    int sys_error = lstat(dm_resolved, &st) ? errno : 0;
    snprintf(path, sizeof(path), "/sys/dev/block/%u:%u", major(dm_device), minor(dm_device));
    int dev_error = lstat(path, &st) ? errno : 0;
    struct observation o = enumerate("/sys/block/ram0/holders", false);
    struct dm_text out = {0}; dm_text_add(&out, "{\"sysfs_errno\":%d,\"dev_link_errno\":%d,\"ram_holders_hex\":\"", sys_error, dev_error);
    dm_text_hex(&out, bytes, o.length);
    if (!error && (sys_error != ENOENT || dev_error != ENOENT || o.error || o.close_error || !o.eof || o.length))
        error = o.error ? o.error : o.close_error ? o.close_error : EPROTO;
    int node_error = 0, control_error = 0;
    if (!error) { node_error = dm_unlink_owned(DM_NODE, &dm_node, &dm_node_exists); if (node_error) error = node_error; }
    if (!error) { control_error = dm_unlink_owned(DM_CONTROL, &dm_control_node, &dm_control_exists); if (control_error) error = control_error; }
    dm_text_add(&out, "\",\"node_unlink_errno\":%d,\"control_unlink_errno\":%d,\"node_exists\":%s,\"control_exists\":%s}",
        node_error, control_error, dm_node_exists ? "true" : "false", dm_control_exists ? "true" : "false");
    if (out.error && !error) error = out.error;
    int e = f3_event("dm-removed", "cleanup", error, o.close_error, out.raw, out.length);
    return error ? error : e;
}

static int dm_bootstrap(void) {
    if (getpid() != 1 || getuid() != 0 || geteuid() != 0) return 77;
    bool loaded = false, node = false, mounted = false, children_done = true, metadata_ok = false;
    const char *mountpoint = "/mnt/f3-prepare";
    int original = 0, cleanup_error = 0, fd = -1, rc = 0, error = 0, ce = 0;
    struct child_result child = ordinary_child("p1");
    if (!child_ok(child) || output_error) { original = child.error ? child.error : child.close_error ? child.close_error : EPROTO; children_done = child.pid <= 0 || child.reaped; goto cleanup; }
    struct observation baseline = enumerate("/sys/block", true);
    if (baseline.error || baseline.close_error || !baseline.eof || baseline.length > sizeof(dm_baseline)) {
        original = baseline.error ? baseline.error : baseline.close_error ? baseline.close_error : EPROTO; goto cleanup;
    }
    memcpy(dm_baseline, bytes, baseline.length); dm_baseline_size = baseline.length;
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
    if ((original = dm_create_graph(&node)) || output_error) { if (!original) original = EIO; goto cleanup; }
    child = dm_format_child(); children_done = child.pid <= 0 || child.reaped;
    if (!child_ok(child) || output_error) { original = child.error ? child.error : child.close_error ? child.close_error : EPROTO; goto cleanup; }
    if ((original = dm_raw_metadata("prepared")) || output_error) { if (!original) original = EIO; goto cleanup; }
    rc = mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL); error = rc ? errno : 0;
    event("mount-private", rc, error, 0, "", 0);
    if (error || output_error) { original = error ? error : EIO; goto cleanup; }

    mountpoint = "/mnt/f3-prepare";
    if ((original = dm_mount_at(mountpoint,"prepare",&mounted))) goto cleanup;
    if ((original = dm_prepare_objects())) goto cleanup;
    if ((original = dm_unmount_at(mountpoint,"prepare",&mounted))) goto cleanup;
    mountpoint = "/mnt/brd";
    if ((original = dm_round("control",false,&mounted,&children_done))) goto cleanup;
    if ((original = dm_round("read",true,&mounted,&children_done))) goto cleanup;
    metadata_ok = true;
cleanup:
    ce = close_once(&fd); if (ce && !cleanup_error) cleanup_error = ce;
    event("cleanup-fd",ce?-1:0,ce,ce,"",0);
    if (mounted && children_done) {
        int e = dm_unmount_at(mountpoint,"cleanup",&mounted); if (e && !cleanup_error) cleanup_error=e;
    } else if (mounted) {
        f3_event("unmount","cleanup",EBUSY,0,"unreaped-child",14); cleanup_error=EBUSY;
    }
    if (dm_created && !mounted && children_done) {
        int e = dm_remove_graph(); if (e && !cleanup_error) cleanup_error = e;
    }
    if (node && !dm_created && !mounted && children_done) {
        struct stat actual={0};
        if (lstat("/dev/ram0",&actual)) {rc=-1;error=errno;}
        else if(actual.st_dev!=owned_node.st_dev||actual.st_ino!=owned_node.st_ino||actual.st_rdev!=owned_node.st_rdev){rc=-1;error=ESTALE;}
        else {rc=unlink("/dev/ram0");error=rc?errno:0;if(!rc)node=false;}
        event("device-remove",rc,error,0,"",0);if(error&&!cleanup_error)cleanup_error=error;
    }
    if (loaded && !dm_created && !dm_node_exists && !mounted && children_done) {
        rc=(int)syscall(SYS_delete_module,"brd",O_NONBLOCK);error=rc?errno:0;if(!rc)loaded=false;
        event("module-unload",rc,error,0,"",0);if(error&&!cleanup_error)cleanup_error=error;
    }
    if(loaded||mounted||node||!children_done||dm_created||dm_node_exists||dm_control_exists||dm_close_unknown) {if(!cleanup_error)cleanup_error=EBUSY;}
    char summary[8192]; int len=snprintf(summary,sizeof(summary),
        "{\"original_errno\":%d,\"cleanup_errno\":%d,\"source_observations_complete\":%s,"
        "\"module_loaded\":%s,\"mounted\":%s,\"node_exists\":%s,\"children_reaped\":%s,\"dm_created\":%s,\"dm_node_exists\":%s,\"dm_control_exists\":%s,\"dm_close_unknown\":%s,\"parent_closes\":[",
        original,cleanup_error,metadata_ok?"true":"false",loaded?"true":"false",mounted?"true":"false",
        node?"true":"false",children_done?"true":"false",dm_created?"true":"false",dm_node_exists?"true":"false",dm_control_exists?"true":"false",dm_close_unknown?"true":"false");
    for(unsigned i=0;i<parent_close_count;++i){
        int added=snprintf(summary+len,sizeof(summary)-(size_t)len,"%s{\"fd\":%d,\"errno\":%d}",
                           i?",":"",parent_closes[i].fd,parent_closes[i].error);
        if(added<0||(size_t)added>=sizeof(summary)-(size_t)len){output_error=true;break;}
        len+=added;
    }
    if((size_t)len+3<sizeof(summary)){memcpy(summary+len,"]}",3);len+=2;}else output_error=true;
    bool ok=!original&&!cleanup_error&&!output_error&&metadata_ok;
    f3_event("guest-complete","cleanup",original?original:cleanup_error?cleanup_error:output_error?EIO:0,
             cleanup_error,summary,(size_t)len);
    if(reboot(RB_POWER_OFF)){f3_event("poweroff-failed","cleanup",errno,0,"",0);return 1;}
    return ok?0:1;
}


#ifndef F3_DM_PURE_TEST
int main(int argc, char **argv) {
    (void)f3_bootstrap; (void)bootstrap_f2; (void)metadata;
    if (argc != 2 || (strcmp(argv[1], "bootstrap") && strcmp(argv[1], "p1") && strcmp(argv[1], "metadata")
        && strcmp(argv[1], "context") && strcmp(argv[1], "ordinary"))) return 64;
    bool boot = !strcmp(argv[1], "bootstrap");
    if (boot ? (getpid() != 1 || getuid() || geteuid()) : (getuid() != 1000 || geteuid() != 1000 || getppid() != 1)) return 77;
    if (load_uuid("/run/run-id", run_id) || load_uuid("/run/fs-uuid", fs_uuid) || load_uuid("/run/hash-seed", hash_seed) || dm_names()) return 65;
    if (boot) return dm_bootstrap();
    if (!strcmp(argv[1], "p1")) return collect_p1();
    if (dm_ordinary_fds() || dm_load_source()) return 77;
    if (!strcmp(argv[1], "metadata")) return dm_metadata();
    char *native_argv[] = {"brdf3-dm-native", argv[1], "1000", "1000", "/mnt/brd", NULL};
    return brdf3_sp_main(5, native_argv);
}
#endif
