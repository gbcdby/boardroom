/* Private F3 guest. Existing F2 primitives remain byte-for-byte read-only. */
#define F2_PURE_TEST 1
#include "f2-guest.c"
#include <sys/xattr.h>

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "The fixed F3 guest ABI is x86_64 little endian"
#endif

#define F3_BLOCK_BYTES 4096U
#define F3_BLOCKS 16384U
#define F3_FRAME_BYTES 65536U
/* Reserve the remaining serial budget for unchanged P1/native/cleanup output. */
#define F3_ENCODED_BYTES (7U * 1024U * 1024U)
static unsigned f3_sequence;
static size_t f3_wire_bytes;

static int f3_event(const char *name, const char *phase, int error, int close_error,
                    const void *data, size_t length) {
    char line[F3_FRAME_BYTES];
    if (length > (F3_FRAME_BYTES - 512U) / 2U) { output_error = true; return EFBIG; }
    int n = snprintf(line, sizeof(line),
        "BRDF3 {\"run_id\":\"%s\",\"origin\":\"management\",\"seq\":%u,"
        "\"event\":\"%s\",\"phase\":\"%s\",\"rc\":%d,\"errno\":%d,\"close_errno\":%d,"
        "\"bytes\":%zu,\"data_hex\":\"", run_id, ++f3_sequence, name, phase,
        error || close_error ? -1 : 0, error, close_error, length);
    if (n < 0 || (size_t)n + 2U * length + 4U > sizeof(line)) { output_error = true; return EFBIG; }
    static const char hex[] = "0123456789abcdef";
    const unsigned char *raw = data;
    for (size_t i = 0; i < length; ++i) {
        line[n++] = hex[raw[i] >> 4]; line[n++] = hex[raw[i] & 15];
    }
    memcpy(line + n, "\"}\n", 3); n += 3;
    if ((size_t)n > F3_ENCODED_BYTES - f3_wire_bytes) { output_error = true; return EFBIG; }
    f3_wire_bytes += (size_t)n;
    if (fwrite(line, 1, (size_t)n, stdout) != (size_t)n || fflush(stdout) || ferror(stdout)) {
        output_error = true; return errno ? errno : EIO;
    }
    return 0;
}

/* Every block is actually read once. A short/error read is not a zero run.
 * The outer production owner binds this FD to its exact whole-brd and closes it.
 * Pure controls call this stream function with an owned regular-file FD only. */
static int f3_stream_blocks(const char *phase, int fd) {
    unsigned char raw[F3_BLOCK_BYTES + sizeof(uint32_t)];
    uint32_t zero_start = 0, zero_count = 0;
    for (uint32_t index = 0; index < F3_BLOCKS; ++index) {
        int error = read_at(fd, raw + sizeof(index), F3_BLOCK_BYTES, (uint64_t)index * F3_BLOCK_BYTES);
        if (error) return error;
        bool all_zero = true;
        for (size_t j = sizeof(index); j < sizeof(raw); ++j) if (raw[j]) { all_zero = false; break; }
        if (all_zero) {
            if (!zero_count) zero_start = index;
            ++zero_count;
            continue;
        }
        if (zero_count) {
            uint32_t run[] = {zero_start, zero_count};
            error = f3_event("snapshot-zero", phase, 0, 0, run, sizeof(run));
            if (error) return error;
            zero_count = 0;
        }
        memcpy(raw, &index, sizeof(index));
        error = f3_event("snapshot-data", phase, 0, 0, raw, sizeof(raw));
        if (error) return error;
    }
    if (zero_count) {
        uint32_t run[] = {zero_start, zero_count};
        return f3_event("snapshot-zero", phase, 0, 0, run, sizeof(run));
    }
    return 0;
}

#ifndef F3_FIXED_INPUTS
#error "Compile F3 only with its fixed source/payload header"
#endif

static uint64_t f3_now(clockid_t clock, int *error) {
    struct timespec value = {0};
    if (clock_gettime(clock, &value)) { if (!*error) *error = errno; return 0; }
    return (uint64_t)value.tv_sec * 1000000000U + (uint64_t)value.tv_nsec;
}

static bool f3_same_stat(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_rdev == b->st_rdev &&
        a->st_mode == b->st_mode && a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
        a->st_nlink == b->st_nlink && a->st_size == b->st_size &&
        a->st_atim.tv_sec == b->st_atim.tv_sec && a->st_atim.tv_nsec == b->st_atim.tv_nsec &&
        a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
        a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}

static int f3_binding(char *target, size_t capacity, int fd, const struct stat *s, uint64_t at, bool closed) {
    return snprintf(target, capacity,
        "{\"fd\":%d,\"device_dev\":%ju,\"device_inode\":%ju,\"rdev\":%ju,"
        "\"mode\":%u,\"uid\":%u,\"gid\":%u,\"nlink\":%ju,\"bytes\":67108864,"
        "\"block_bytes\":4096,\"at_ns\":\"%"PRIu64"\",\"closed\":%s}",
        fd, (uintmax_t)s->st_dev, (uintmax_t)s->st_ino, (uintmax_t)s->st_rdev,
        s->st_mode, s->st_uid, s->st_gid, (uintmax_t)s->st_nlink, at, closed ? "true" : "false");
}

static int f3_snapshot(const char *phase) {
    int fd = device_open(), error = fd < 0 ? errno : 0, ce = 0;
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
        if (lstat("/dev/ram0", &path) && !error) error = errno;
        if ((!f3_same_stat(&before, &after) || before.st_dev != path.st_dev || before.st_ino != path.st_ino ||
             before.st_rdev != path.st_rdev) && !error) error = ESTALE;
    }
    ce = close_once(&fd);
    uint64_t end = f3_now(CLOCK_MONOTONIC, &error);
    n = f3_binding(text, sizeof(text), saved, &after, end, ce == 0 && saved >= 0);
    emitted = f3_event("snapshot-end", phase, error, ce, text, (size_t)n);
    return error ? error : ce ? ce : emitted;
}

static int f3_raw_superblock(const char *phase) {
    int fd = device_open(), error = fd < 0 ? errno : 0;
    unsigned char raw[1024] = {0};
    if (!error) error = read_at(fd, raw, sizeof(raw), 1024);
    int ce = close_once(&fd), emitted = f3_event("mount-base", phase, error, ce, raw, sizeof(raw));
    return error ? error : ce ? ce : emitted;
}

static int f3_statistics(const char *phase, bool before) {
    struct observation o = read_file("/sys/block/ram0/stat", 4096);
    int error = o.error ? o.error : o.close_error ? o.close_error : !o.eof ? EIO : 0;
    char text[10000]; size_t at = 0;
    uint64_t mono = f3_now(CLOCK_MONOTONIC, &error), real = f3_now(CLOCK_REALTIME, &error);
    int n = snprintf(text, sizeof(text), "{\"monotonic_ns\":\"%"PRIu64"\",\"realtime_ns\":\"%"PRIu64"\",\"raw_hex\":\"", mono, real);
    if (n < 0 || (size_t)n + 2U * o.length + 4U > sizeof(text)) return EFBIG;
    at = (size_t)n; static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < o.length; ++i) { text[at++] = hex[bytes[i] >> 4]; text[at++] = hex[bytes[i] & 15]; }
    memcpy(text + at, "\"}", 2); at += 2;
    int emitted = f3_event(before ? "block-stat-before" : "block-stat-after", phase, error, o.close_error, text, at);
    return error ? error : emitted;
}

static int f3_close_view(const char *phase, const char *name, int *fd) {
    int saved = *fd, ce = close_once(fd);
    char text[128]; int n = snprintf(text, sizeof(text), "{\"name\":\"%s\",\"fd\":%d}", name, saved);
    int emitted = f3_event("view-close", phase, 0, ce, text, (size_t)n);
    return ce ? ce : emitted;
}

static int f3_members(const char *phase, int root) {
    int fd = openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NOATIME | O_CLOEXEC);
    int error = fd < 0 ? errno : 0, ce = 0; unsigned char names[1024]; size_t used = 0; unsigned count = 0;
    struct stat a = {0}, b = {0};
    if (!error && (fstat(fd, &a) || fstat(root, &b))) error = errno;
    if (!error && (a.st_dev != b.st_dev || a.st_ino != b.st_ino)) error = ESTALE;
    DIR *dir = NULL; int saved = fd;
    if (!error) { dir = fdopendir(fd); if (!dir) error = errno; else fd = -1; }
    if (dir) {
        for (;;) {
            errno = 0; struct dirent *entry = readdir(dir);
            if (!entry) { if (errno && !error) error = errno; break; }
            if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
            size_t len = strlen(entry->d_name) + 1;
            if (++count > 16 || len > sizeof(names)-used) { error = EFBIG; break; }
            memcpy(names+used, entry->d_name, len); used += len;
        }
        if (closedir(dir)) ce = errno;
        if (getpid() == 1) {
            if (parent_close_count < 128) {
                parent_closes[parent_close_count].fd = saved; parent_closes[parent_close_count++].error = ce;
            } else output_error = true;
        }
    }
    { int other = close_once(&fd); if (!ce) ce = other; }
    int emitted = f3_event("view-members", phase, error, ce, names, used);
    return error ? error : ce ? ce : emitted;
}

static int f3_object_view(const char *phase, int root, const char *name) {
    int fd = openat(root, name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    int error = fd < 0 ? errno : 0, ce = 0;
    struct stat first = {0}, held = {0}, path = {0};
    if (!error && fstat(fd, &first)) error = errno;
    bool payload = !strcmp(name, "payload"), lost_found = !strcmp(name, "lost+found");
    if (!error && (first.st_dev != makedev(1,0) || (payload ? !S_ISREG(first.st_mode) || first.st_nlink != 1 : !S_ISDIR(first.st_mode)) ||
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

static int f3_source_view(const char *phase) {
    int root = open("/mnt/brd", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int error = root < 0 ? errno : 0; struct stat before = {0}, after = {0}, path = {0};
    if (!error && fstat(root, &before)) error = errno;
    if (!error && (before.st_dev != makedev(1,0) || before.st_ino != 2 ||
        before.st_mode != (S_IFDIR | 0700) || before.st_uid != 1000 || before.st_gid != 1000)) error = EPROTO;
    char text[256]; int n = snprintf(text, sizeof(text),
        "{\"root_fd\":%d,\"dev\":%ju,\"ino\":%ju,\"object_count\":5,\"ordinary_source_open_count\":0}",
        root, (uintmax_t)before.st_dev, (uintmax_t)before.st_ino);
    int emitted = f3_event("view-begin", phase, error, 0, text, (size_t)n);
    if (!error) error = emitted;
    if (!error) error = f3_members(phase, root);
    const char *names[] = {".", "payload", "directory", "ancestor", "lost+found"};
    for (unsigned i = 0; !error && i < 5; ++i) error = f3_object_view(phase, root, names[i]);
    if (root >= 0) {
        if ((fstat(root, &after) || lstat("/mnt/brd", &path)) && !error) error = errno;
        if ((!f3_same_stat(&before, &after) || !f3_same_stat(&before, &path)) && !error) error = ESTALE;
    }
    int ce = f3_close_view(phase, "root", &root);
    emitted = f3_event("view-end", phase, error, ce, text, (size_t)n);
    return error ? error : ce ? ce : emitted;
}

static int f3_prepare_objects(void) {
    int root = open("/mnt/f3-prepare", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NOATIME | O_CLOEXEC);
    int error = root < 0 ? errno : 0, fd = -1, cleanup = 0;
    struct stat source = {0};
    if (!error && fstat(root, &source)) error = errno;
    if (!error && (source.st_dev != makedev(1,0) || source.st_ino != 2)) error = EPROTO;
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
