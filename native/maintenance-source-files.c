/* #152 P0 Linux source-file bridge: opaque, owned, strictly read-only native FDs.
 * This is not a source-preservation qualification or a source-files manifest.
 */
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <linux/stat.h>
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/ioctl.h>
#include <sys/sysmacros.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
#include <time.h>
#include <unistd.h>
#include <dirent.h>

#define MAX_PATH_BYTES 4096
#define MAX_READ_BYTES 65536
#define MAX_DIRECTORY_ENTRIES 4096
#define MAX_FID_BYTES 128
#define MAX_XATTR_ENTRIES 64
#define MAX_XATTR_BYTES 65536

/* Fixed Linux v6.18 UAPI declarations, not a filesystem support claim.
 * https://github.com/torvalds/linux/blob/v6.18/include/uapi/linux/fs.h
 * https://github.com/torvalds/linux/blob/v6.18/include/uapi/linux/fcntl.h
 * Missing declarations may be supplied; syscall numbers are never guessed. */
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
_Static_assert(sizeof(struct fsuuid2) == 17 && offsetof(struct fsuuid2, uuid) == 1, "fsuuid2 UAPI");
_Static_assert(_IOC_SIZE(FS_IOC_GETFSUUID) == 17 && _IOC_TYPE(FS_IOC_GETFSUUID) == 0x15 &&
               _IOC_NR(FS_IOC_GETFSUUID) == 0 && _IOC_DIR(FS_IOC_GETFSUUID) == _IOC_READ, "GETFSUUID UAPI");
_Static_assert(sizeof(struct file_handle) == 8 && offsetof(struct file_handle, f_handle) == 8, "file_handle UAPI");
_Static_assert(sizeof(int) == 4 && sizeof(uint64_t) == 8, "native integer ABI");
_Static_assert(AT_HANDLE_FID == 0x200 && AT_HANDLE_MNT_ID_UNIQUE == 1, "handle flags UAPI");

typedef struct {
  int fd;
  bool directory;
  bool close_unknown;
} source_owner;

static napi_value throw_code(napi_env env, const char *code, const char *message) {
  napi_value text, error;
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) == napi_ok &&
      napi_create_error(env, NULL, text, &error) == napi_ok) {
    napi_value field;
    if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &field) == napi_ok)
      (void)napi_set_named_property(env, error, "code", field);
    (void)napi_throw(env, error);
  }
  return NULL;
}
static napi_value os_error(napi_env env, const char *stage) {
  const int saved = errno;
  napi_value text, error, code, syscall, number, rc;
  if (napi_create_string_utf8(env, "Source-file native operation failed", NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_error(env, NULL, text, &error) != napi_ok ||
      napi_create_string_utf8(env, "ERR_SOURCE_NATIVE_IO", NAPI_AUTO_LENGTH, &code) != napi_ok ||
      napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &syscall) != napi_ok ||
      napi_create_int32(env, saved, &number) != napi_ok ||
      napi_create_int32(env, -1, &rc) != napi_ok ||
      napi_set_named_property(env, error, "code", code) != napi_ok ||
      napi_set_named_property(env, error, "syscall", syscall) != napi_ok ||
      napi_set_named_property(env, error, "errno", number) != napi_ok ||
      napi_set_named_property(env, error, "rc", rc) != napi_ok) return NULL;
  (void)napi_throw(env, error);
  return NULL;
}
static bool string_arg(napi_env env, napi_value value, char *output, size_t capacity,
                       bool leaf, bool absolute) {
  size_t bytes = 0, copied = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &bytes) != napi_ok || bytes == 0 || bytes >= capacity ||
      napi_get_value_string_utf8(env, value, output, capacity, &copied) != napi_ok || copied != bytes ||
      memchr(output, '\0', bytes) != NULL) return false;
  if (absolute && output[0] != '/') return false;
  if (leaf && (strchr(output, '/') != NULL || strcmp(output, ".") == 0 || strcmp(output, "..") == 0)) return false;
  return true;
}
static void owner_finalizer(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  source_owner *owner = data;
  /* If close returned an unknown result, never risk closing a recycled integer. */
  if (owner->fd >= 0 && !owner->close_unknown) (void)close(owner->fd);
  free(owner);
}
static napi_value wrap_owner(napi_env env, int fd, bool directory) {
  source_owner *owner = calloc(1, sizeof(*owner));
  if (!owner) { (void)close(fd); return throw_code(env, "ERR_SOURCE_ALLOC", "Source-file owner allocation failed"); }
  owner->fd = fd;
  owner->directory = directory;
  napi_value value;
  if (napi_create_object(env, &value) != napi_ok ||
      napi_wrap(env, value, owner, owner_finalizer, NULL, NULL) != napi_ok) {
    (void)close(fd); free(owner);
    return throw_code(env, "ERR_SOURCE_ALLOC", "Source-file owner wrapping failed");
  }
  return value;
}
static bool get_owner(napi_env env, napi_value value, source_owner **out) {
  *out = NULL;
  if (napi_unwrap(env, value, (void **)out) != napi_ok || !*out) return false;
  return (*out)->fd >= 0 && !(*out)->close_unknown;
}
static bool valid_opened(int fd, bool directory) {
  struct stat info;
  if (fstat(fd, &info) != 0) return false;
  return info.st_uid == getuid() &&
    (directory ? S_ISDIR(info.st_mode) : S_ISREG(info.st_mode) && info.st_nlink == 1 && info.st_size >= 0) &&
    (info.st_mode & 0022) == 0;
}
static int strict_openat(int dir, const char *name, bool directory, bool root) {
  struct open_how how = {0};
  how.flags = (uint64_t)(O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK |
    (directory ? O_DIRECTORY : 0));
  how.resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | (root ? 0 : RESOLVE_BENEATH | RESOLVE_NO_XDEV);
  return (int)syscall(SYS_openat2, dir, name, &how, sizeof(how));
}
static napi_value open_root(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; char pathname[MAX_PATH_BYTES + 1];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !string_arg(env, args[0], pathname, sizeof(pathname), false, true))
    return throw_code(env, "ERR_SOURCE_ARGUMENT", "Expected absolute source root");
  int fd = strict_openat(AT_FDCWD, pathname, true, true);
  if (fd < 0) return os_error(env, "openat2-root");
  if (!valid_opened(fd, true)) { (void)close(fd); return throw_code(env, "ERR_SOURCE_IDENTITY", "Invalid source root"); }
  return wrap_owner(env, fd, true);
}
static napi_value open_child(napi_env env, napi_callback_info info) {
  size_t count = 3; napi_value args[3]; char name[MAX_PATH_BYTES + 1]; char kind[16]; source_owner *parent;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3 ||
      !get_owner(env, args[0], &parent) || !parent->directory ||
      !string_arg(env, args[1], name, sizeof(name), true, false) ||
      !string_arg(env, args[2], kind, sizeof(kind), true, false) ||
      (strcmp(kind, "file") != 0 && strcmp(kind, "directory") != 0))
    return throw_code(env, "ERR_SOURCE_ARGUMENT", "Expected live parent, leaf and file or directory");
  if (!valid_opened(parent->fd, true)) return throw_code(env, "ERR_SOURCE_IDENTITY", "Source parent changed");
  bool directory = strcmp(kind, "directory") == 0;
  int fd = strict_openat(parent->fd, name, directory, false);
  if (fd < 0) return os_error(env, "openat2-child");
  if (!valid_opened(fd, directory) || !valid_opened(parent->fd, true)) {
    (void)close(fd); return throw_code(env, "ERR_SOURCE_IDENTITY", "Source entry changed");
  }
  return wrap_owner(env, fd, directory);
}
static bool set_big(napi_env env, napi_value object, const char *name, uint64_t value) {
  napi_value data;
  return napi_create_bigint_uint64(env, value, &data) == napi_ok &&
    napi_set_named_property(env, object, name, data) == napi_ok;
}
static bool set_int(napi_env env, napi_value object, const char *name, int64_t value) {
  napi_value data;
  return napi_create_bigint_int64(env, value, &data) == napi_ok &&
    napi_set_named_property(env, object, name, data) == napi_ok;
}
static bool time_ns(struct timespec value, int64_t *result) {
  int64_t seconds;
  return !__builtin_mul_overflow((int64_t)value.tv_sec, INT64_C(1000000000), &seconds) &&
    !__builtin_add_overflow(seconds, (int64_t)value.tv_nsec, result);
}
static napi_value observe(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !get_owner(env, args[0], &owner))
    return throw_code(env, "ERR_SOURCE_HANDLE", "Source handle closed or unknown");
  struct stat st; struct statfs fs;
  if (fstat(owner->fd, &st) != 0 || fstatfs(owner->fd, &fs) != 0) return os_error(env, "observe-fd");
  if (!valid_opened(owner->fd, owner->directory)) return throw_code(env, "ERR_SOURCE_IDENTITY", "Source entry changed");
  int64_t mtime, ctime;
  if (!time_ns(st.st_mtim, &mtime) || !time_ns(st.st_ctim, &ctime))
    return throw_code(env, "ERR_SOURCE_OVERFLOW", "Source timestamp overflow");
  napi_value object, kind;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_create_string_utf8(env, owner->directory ? "directory" : "file", NAPI_AUTO_LENGTH, &kind) != napi_ok ||
      napi_set_named_property(env, object, "kind", kind) != napi_ok ||
      !set_big(env, object, "dev", (uint64_t)st.st_dev) ||
      !set_big(env, object, "ino", (uint64_t)st.st_ino) ||
      !set_big(env, object, "mode", (uint64_t)st.st_mode) ||
      !set_big(env, object, "uid", (uint64_t)st.st_uid) ||
      !set_big(env, object, "nlink", (uint64_t)st.st_nlink) ||
      !set_big(env, object, "size", (uint64_t)st.st_size) ||
      !set_big(env, object, "fsType", (uint64_t)fs.f_type) ||
      !set_int(env, object, "mtimeNs", mtime) || !set_int(env, object, "ctimeNs", ctime))
    return throw_code(env, "ERR_SOURCE_RESULT", "Could not encode source observation");
  return object;
}

/* P1: these are facts about the already-owned FD, never a pathname lookup or
 * an admission/profile decision. Unsupported optional statx fields stay null. */
static napi_value observe_statx(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !get_owner(env, args[0], &owner))
    return throw_code(env, "ERR_SOURCE_HANDLE", "Source handle closed or unknown");
  struct stat before, after;
  struct statx facts = {0};
  if (fstat(owner->fd, &before) != 0) return os_error(env, "statx-before-fstat");
  if (!valid_opened(owner->fd, owner->directory))
    return throw_code(env, "ERR_SOURCE_IDENTITY", "Source entry changed before statx");
  if (syscall(SYS_statx, owner->fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT,
              STATX_BASIC_STATS | STATX_BTIME | STATX_MNT_ID, &facts) != 0)
    return os_error(env, "statx-owned-fd");
  if (fstat(owner->fd, &after) != 0) return os_error(env, "statx-after-fstat");
  if (!valid_opened(owner->fd, owner->directory) ||
      before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_mode != after.st_mode || before.st_uid != after.st_uid ||
      before.st_nlink != after.st_nlink || before.st_size != after.st_size ||
      before.st_mtim.tv_sec != after.st_mtim.tv_sec ||
      before.st_mtim.tv_nsec != after.st_mtim.tv_nsec ||
      before.st_ctim.tv_sec != after.st_ctim.tv_sec ||
      before.st_ctim.tv_nsec != after.st_ctim.tv_nsec ||
      (facts.stx_mask & STATX_BASIC_STATS) != STATX_BASIC_STATS ||
      facts.stx_ino != (uint64_t)before.st_ino ||
      facts.stx_dev_major != major(before.st_dev) ||
      facts.stx_dev_minor != minor(before.st_dev) ||
      facts.stx_uid != before.st_uid ||
      facts.stx_mode != before.st_mode ||
      facts.stx_nlink != before.st_nlink ||
      facts.stx_size != (uint64_t)before.st_size)
    return throw_code(env, "ERR_SOURCE_IDENTITY", "Source FD statx and fstat disagree");
  napi_value object, kind, mount_id, birthtime;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_create_string_utf8(env, owner->directory ? "directory" : "file", NAPI_AUTO_LENGTH, &kind) != napi_ok ||
      napi_set_named_property(env, object, "kind", kind) != napi_ok ||
      !set_big(env, object, "mask", (uint64_t)facts.stx_mask) ||
      !set_big(env, object, "devMajor", (uint64_t)facts.stx_dev_major) ||
      !set_big(env, object, "devMinor", (uint64_t)facts.stx_dev_minor) ||
      !set_big(env, object, "ino", (uint64_t)facts.stx_ino) ||
      !set_big(env, object, "attributes", facts.stx_attributes) ||
      !set_big(env, object, "attributesMask", facts.stx_attributes_mask))
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode source statx");
  if ((facts.stx_mask & STATX_MNT_ID) != 0) {
    if (napi_create_bigint_uint64(env, facts.stx_mnt_id, &mount_id) != napi_ok)
      return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode mount ID");
  } else if (napi_get_null(env, &mount_id) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode absent mount ID");
  if ((facts.stx_mask & STATX_BTIME) != 0) {
    int64_t birth_ns;
    if (facts.stx_btime.tv_nsec >= 1000000000u ||
        !time_ns((struct timespec){ .tv_sec = facts.stx_btime.tv_sec, .tv_nsec = facts.stx_btime.tv_nsec }, &birth_ns) ||
        napi_create_bigint_int64(env, birth_ns, &birthtime) != napi_ok)
      return throw_code(env, "ERR_SOURCE_OVERFLOW", "Invalid source birthtime");
  } else if (napi_get_null(env, &birthtime) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode absent source birthtime");
  if (napi_set_named_property(env, object, "mountId", mount_id) != napi_ok ||
      napi_set_named_property(env, object, "birthtimeNs", birthtime) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot return source statx");
  return object;
}

/* P2 returns ordinary same-owner facts with bounded, raw syscall diagnostics.
 * Unavailable facts have no value; a missing call has null rc/errno. No caller
 * flag, path reopen, extra descriptor, privilege change, or source write exists. */
static bool set_text(napi_env env, napi_value object, const char *name, const char *text) {
  napi_value value;
  return napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value) == napi_ok &&
    napi_set_named_property(env, object, name, value) == napi_ok;
}
static bool append_call(napi_env env, napi_value calls, const char *operation, bool ran, int64_t rc, int error) {
  napi_value call, missing; uint32_t length;
  if (napi_create_object(env, &call) != napi_ok || !set_text(env, call, "operation", operation) ||
      napi_get_array_length(env, calls, &length) != napi_ok) return false;
  if (ran) {
    if (!set_int(env, call, "rc", rc) || !set_int(env, call, "errno", error)) return false;
  } else if (napi_get_null(env, &missing) != napi_ok ||
      napi_set_named_property(env, call, "rc", missing) != napi_ok ||
      napi_set_named_property(env, call, "errno", missing) != napi_ok) return false;
  return napi_set_element(env, calls, length, call) == napi_ok;
}
static napi_value fact(napi_env env, napi_value calls, napi_value value, const char *reason) {
  napi_value result, missing;
  if (napi_create_object(env, &result) != napi_ok || napi_get_null(env, &missing) != napi_ok ||
      !set_text(env, result, "status", reason ? "unavailable" : "observed") ||
      napi_set_named_property(env, result, "calls", calls) != napi_ok ||
      napi_set_named_property(env, result, "value", reason ? missing : value) != napi_ok ||
      (reason ? !set_text(env, result, "reason", reason) :
        napi_set_named_property(env, result, "reason", missing) != napi_ok))
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode native fact");
  return result;
}
static napi_value uuid_fact(napi_env env, int fd) {
  struct fsuuid2 uuid = {0}; napi_value calls, value, bytes;
  errno = 0; const int rc = ioctl(fd, FS_IOC_GETFSUUID, &uuid), error = errno;
  if (napi_create_array(env, &calls) != napi_ok || !append_call(env, calls, "ioctl-getfsuuid", true, rc, error))
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode UUID call");
  if (rc != 0) return fact(env, calls, NULL, "syscall");
  if (uuid.len == 0 || uuid.len > sizeof(uuid.uuid)) return fact(env, calls, NULL, "length");
  if (napi_create_object(env, &value) != napi_ok || !set_big(env, value, "length", uuid.len) ||
      napi_create_buffer_copy(env, uuid.len, uuid.uuid, NULL, &bytes) != napi_ok ||
      napi_set_named_property(env, value, "bytes", bytes) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode UUID bytes");
  return fact(env, calls, value, NULL);
}
static napi_value fid_fact(napi_env env, int fd) {
  napi_value calls;
  if (napi_create_array(env, &calls) != napi_ok) return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode FID calls");
#ifdef SYS_name_to_handle_at
  union { max_align_t align; unsigned char raw[sizeof(struct file_handle) + MAX_FID_BYTES]; } buffer = {0};
  struct file_handle *handle = (struct file_handle *)buffer.raw;
  uint64_t mount_id = 0;
  handle->handle_bytes = MAX_FID_BYTES;
  errno = 0; const long rc = syscall(SYS_name_to_handle_at, fd, "", handle, &mount_id,
    AT_EMPTY_PATH | AT_HANDLE_FID | AT_HANDLE_MNT_ID_UNIQUE); const int error = errno;
  if (!append_call(env, calls, "name-to-handle-at", true, rc, error))
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode FID call");
  if (rc != 0) return fact(env, calls, NULL, "syscall");
  if (!handle->handle_bytes || handle->handle_bytes > MAX_FID_BYTES || handle->handle_bytes % sizeof(uint32_t))
    return fact(env, calls, NULL, "length");
  if (handle->handle_type <= 0 || handle->handle_type == 255 || !mount_id)
    return fact(env, calls, NULL, "identity");
  napi_value value, bytes;
  if (napi_create_object(env, &value) != napi_ok || !set_int(env, value, "handleType", handle->handle_type) ||
      !set_big(env, value, "handleBytes", handle->handle_bytes) || !set_big(env, value, "mountId", mount_id) ||
      napi_create_buffer_copy(env, handle->handle_bytes, handle->f_handle, NULL, &bytes) != napi_ok ||
      napi_set_named_property(env, value, "bytes", bytes) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode FID bytes");
  return fact(env, calls, value, NULL);
#else
  (void)fd;
  if (!append_call(env, calls, "name-to-handle-at", false, 0, 0))
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode absent FID call");
  return fact(env, calls, NULL, "abi");
#endif
}
static napi_value flags_fact(napi_env env, int fd) {
  /* The ioctl command uses sizeof(long); the kernel copies a u32 flags value.
   * See Linux v6.18 fs/ioctl.c, including its 32-bit compatibility handling. */
  uint32_t flags = 0; napi_value calls, value;
  errno = 0; const int rc = ioctl(fd, FS_IOC_GETFLAGS, &flags), error = errno;
  if (napi_create_array(env, &calls) != napi_ok || !append_call(env, calls, "ioctl-getflags", true, rc, error))
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode inode flags call");
  if (rc != 0) return fact(env, calls, NULL, "syscall");
  if (napi_create_bigint_uint64(env, flags, &value) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode inode flags");
  return fact(env, calls, value, NULL);
}
static int compare_xattr_names(const void *left, const void *right) {
  return strcmp(*(const char *const *)left, *(const char *const *)right);
}
static const char *xattr_names(char *buffer, size_t size, char **names, size_t *count, size_t *total) {
  *count = 0; *total = 0;
  for (size_t at = 0; at < size;) {
    const char *end = memchr(buffer + at, '\0', size - at);
    if (!end || end == buffer + at || (size_t)(end - (buffer + at)) > 255) return "enumeration";
    if (*count == MAX_XATTR_ENTRIES) return "budget";
    names[(*count)++] = buffer + at;
    const size_t length = (size_t)(end - (buffer + at));
    *total += length; at += length + 1;
  }
  qsort(names, *count, sizeof(*names), compare_xattr_names);
  for (size_t i = 1; i < *count; i++) if (!strcmp(names[i-1], names[i])) return "enumeration";
  return NULL;
}
static napi_value xattr_fact(napi_env env, int fd) {
  napi_value calls, entries;
  if (napi_create_array(env, &calls) != napi_ok || napi_create_array(env, &entries) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode xattr collection");
  char *buffer = malloc(MAX_XATTR_BYTES * 3);
  if (!buffer) return throw_code(env, "ERR_SOURCE_ALLOC", "Cannot allocate bounded xattr buffers");
  char *again = buffer + MAX_XATTR_BYTES;
  unsigned char *bytes = (unsigned char *)buffer + MAX_XATTR_BYTES * 2;
  char *names[MAX_XATTR_ENTRIES], *after_names[MAX_XATTR_ENTRIES];
  size_t count, total, after_count, after_total;
  const char *reason = NULL;
  bool last_ran = false, encoded = true;
  errno = 0; ssize_t rc = flistxattr(fd, buffer, MAX_XATTR_BYTES); int error = errno;
  if (!append_call(env, calls, "flistxattr-before", true, rc, error)) { encoded = false; goto done; }
  if (rc < 0) { reason = "syscall"; goto done; }
  if (rc > MAX_XATTR_BYTES) { reason = "budget"; goto done; }
  reason = xattr_names(buffer, (size_t)rc, names, &count, &total);
  if (reason) goto done;
  for (size_t i = 0; i < count; i++) {
    const size_t capacity = MAX_XATTR_BYTES - total;
    errno = 0; rc = fgetxattr(fd, names[i], bytes, capacity); error = errno;
    if (!append_call(env, calls, "fgetxattr", true, rc, error)) { encoded = false; goto done; }
    if (rc < 0) { reason = "syscall"; goto done; }
    if ((uint64_t)rc > capacity) { reason = "budget"; goto done; }
    napi_value entry, name, value;
    if (napi_create_object(env, &entry) != napi_ok ||
        napi_create_buffer_copy(env, strlen(names[i]), names[i], NULL, &name) != napi_ok ||
        napi_create_buffer_copy(env, (size_t)rc, bytes, NULL, &value) != napi_ok ||
        napi_set_named_property(env, entry, "name", name) != napi_ok ||
        napi_set_named_property(env, entry, "value", value) != napi_ok ||
        napi_set_element(env, entries, (uint32_t)i, entry) != napi_ok) { encoded = false; goto done; }
    total += (size_t)rc;
  }
  errno = 0; rc = flistxattr(fd, again, MAX_XATTR_BYTES); error = errno; last_ran = true;
  if (!append_call(env, calls, "flistxattr-after", true, rc, error)) { encoded = false; goto done; }
  if (rc < 0) { reason = "syscall"; goto done; }
  if (rc > MAX_XATTR_BYTES) { reason = "budget"; goto done; }
  reason = xattr_names(again, (size_t)rc, after_names, &after_count, &after_total);
  if (reason) goto done;
  if (after_count != count) { reason = "enumeration"; goto done; }
  for (size_t i = 0; i < count; i++) if (strcmp(names[i], after_names[i])) { reason = "enumeration"; break; }
done:
  free(buffer);
  if (encoded && !last_ran) encoded = append_call(env, calls, "flistxattr-after", false, 0, 0);
  if (!encoded) return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode xattr result");
  return fact(env, calls, entries, reason);
}
static bool same_metadata(const struct stat *before, const struct stat *after) {
  return before->st_dev == after->st_dev && before->st_ino == after->st_ino &&
    before->st_mode == after->st_mode && before->st_uid == after->st_uid && before->st_gid == after->st_gid &&
    before->st_nlink == after->st_nlink && before->st_size == after->st_size &&
    before->st_atim.tv_sec == after->st_atim.tv_sec && before->st_atim.tv_nsec == after->st_atim.tv_nsec &&
    before->st_mtim.tv_sec == after->st_mtim.tv_sec && before->st_mtim.tv_nsec == after->st_mtim.tv_nsec &&
    before->st_ctim.tv_sec == after->st_ctim.tv_sec && before->st_ctim.tv_nsec == after->st_ctim.tv_nsec;
}
static bool valid_metadata(const struct stat *st, bool directory) {
  return st->st_uid == getuid() && (st->st_mode & 0022) == 0 &&
    (directory ? S_ISDIR(st->st_mode) : S_ISREG(st->st_mode) && st->st_nlink == 1 && st->st_size >= 0);
}
static napi_value extended_metadata(napi_env env, const struct stat *st, const struct statfs *fs, bool directory) {
  napi_value value; int64_t atime, mtime, ctime;
  if (!time_ns(st->st_atim, &atime) || !time_ns(st->st_mtim, &mtime) || !time_ns(st->st_ctim, &ctime))
    return throw_code(env, "ERR_SOURCE_OVERFLOW", "Source timestamp overflow");
  if (napi_create_object(env, &value) != napi_ok || !set_text(env, value, "kind", directory ? "directory" : "file") ||
      !set_big(env, value, "dev", st->st_dev) || !set_big(env, value, "ino", st->st_ino) ||
      !set_big(env, value, "mode", st->st_mode) || !set_big(env, value, "uid", st->st_uid) ||
      !set_big(env, value, "gid", st->st_gid) || !set_big(env, value, "nlink", st->st_nlink) ||
      !set_big(env, value, "size", st->st_size) || !set_big(env, value, "fsType", (uint64_t)fs->f_type) ||
      !set_int(env, value, "atimeNs", atime) || !set_int(env, value, "mtimeNs", mtime) || !set_int(env, value, "ctimeNs", ctime))
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode extended metadata");
  return value;
}
static napi_value observe_extended(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1], value, calls, before_value, after_value; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 || !get_owner(env, args[0], &owner))
    return throw_code(env, "ERR_SOURCE_HANDLE", "Source handle closed or unknown");
  struct stat before, after; struct statfs fs_before, fs_after;
  errno = 0; const int br = fstat(owner->fd, &before), be = errno;
  if (br != 0) return os_error(env, "extended-before-fstat");
  errno = 0; const int bfr = fstatfs(owner->fd, &fs_before), bfe = errno;
  if (bfr != 0) return os_error(env, "extended-before-fstatfs");
  if (!valid_metadata(&before, owner->directory)) return throw_code(env, "ERR_SOURCE_IDENTITY", "Invalid source before getters");
  if (napi_create_object(env, &value) != napi_ok || napi_create_array(env, &calls) != napi_ok ||
      !append_call(env, calls, "fstat-before", true, br, be) || !append_call(env, calls, "fstatfs-before", true, bfr, bfe))
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode extended observation");
  const char *names[] = { "uuid", "fid", "inodeFlags", "xattrs" };
  napi_value (*getters[])(napi_env, int) = { uuid_fact, fid_fact, flags_fact, xattr_fact };
  for (size_t i = 0; i < sizeof(getters)/sizeof(getters[0]); i++) {
    napi_value result = getters[i](env, owner->fd);
    if (!result) return NULL;
    if (napi_set_named_property(env, value, names[i], result) != napi_ok)
      return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode extended fact");
  }
  errno = 0; const int afr = fstatfs(owner->fd, &fs_after), afe = errno;
  if (afr != 0) return os_error(env, "extended-after-fstatfs");
  errno = 0; const int ar = fstat(owner->fd, &after), ae = errno;
  if (ar != 0) return os_error(env, "extended-after-fstat");
  if (!valid_metadata(&after, owner->directory) || !same_metadata(&before, &after) || fs_before.f_type != fs_after.f_type)
    return throw_code(env, "ERR_SOURCE_IDENTITY", "Source metadata changed during getters");
  before_value = extended_metadata(env, &before, &fs_before, owner->directory);
  if (!before_value) return NULL;
  after_value = extended_metadata(env, &after, &fs_after, owner->directory);
  if (!after_value) return NULL;
  if (!append_call(env, calls, "fstatfs-after", true, afr, afe) || !append_call(env, calls, "fstat-after", true, ar, ae) ||
      napi_set_named_property(env, value, "metadataCalls", calls) != napi_ok ||
      napi_set_named_property(env, value, "before", before_value) != napi_ok ||
      napi_set_named_property(env, value, "after", after_value) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot return extended observation");
  return value;
}

static napi_value read_at(napi_env env, napi_callback_info info) {
  size_t count = 3; napi_value args[3]; source_owner *owner;
  int64_t offset; bool exact; uint32_t length;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3 ||
      !get_owner(env, args[0], &owner) || owner->directory ||
      napi_get_value_bigint_int64(env, args[1], &offset, &exact) != napi_ok || !exact || offset < 0 ||
      napi_get_value_uint32(env, args[2], &length) != napi_ok || length == 0 || length > MAX_READ_BYTES)
    return throw_code(env, "ERR_SOURCE_ARGUMENT", "Expected file, nonnegative exact offset and 1-65536 byte length");
  unsigned char bytes[MAX_READ_BYTES];
  ssize_t found;
  do { found = pread(owner->fd, bytes, length, (off_t)offset); } while (found < 0 && errno == EINTR);
  if (found < 0) return os_error(env, "pread-source");
  napi_value result;
  if (napi_create_buffer_copy(env, (size_t)found, bytes, NULL, &result) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Could not return source bytes");
  return result;
}
static napi_value read_directory(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !get_owner(env, args[0], &owner) || !owner->directory)
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected live source directory");
  if (!valid_opened(owner->fd, true)) return throw_code(env, "ERR_SOURCE_IDENTITY", "Source directory changed");
  int clone = fcntl(owner->fd, F_DUPFD_CLOEXEC, 0);
  if (clone < 0) return os_error(env, "duplicate-source-dir");
  DIR *stream = fdopendir(clone);
  if (!stream) { (void)close(clone); return os_error(env, "fdopendir-source"); }
  napi_value array;
  bool ok = napi_create_array(env, &array) == napi_ok;
  uint32_t length = 0;
  int seen_error = 0;
  if (ok) {
    rewinddir(stream);
    errno = 0;
    for (;;) {
      struct dirent *entry = readdir(stream);
      if (!entry) { seen_error = errno; break; }
      if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) { errno = 0; continue; }
      if (length >= MAX_DIRECTORY_ENTRIES) { seen_error = EOVERFLOW; break; }
      napi_value name;
      if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) != napi_ok ||
          napi_set_element(env, array, length++, name) != napi_ok) { seen_error = EINVAL; break; }
      errno = 0;
    }
  }
  if (closedir(stream) != 0 || seen_error != 0 || !ok || !valid_opened(owner->fd, true))
    return throw_code(env, "ERR_SOURCE_DIRECTORY", "Source directory enumeration incomplete");
  return array;
}
static napi_value close_owner(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !get_owner(env, args[0], &owner))
    return throw_code(env, "ERR_SOURCE_HANDLE", "Source handle already closed or unknown");
  int fd = owner->fd;
  owner->close_unknown = true;
  if (close(fd) != 0) return os_error(env, "close-source");
  owner->fd = -1;
  owner->close_unknown = false;
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    { "openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL },
    { "openChild", NULL, open_child, NULL, NULL, NULL, napi_default, NULL },
    { "observe", NULL, observe, NULL, NULL, NULL, napi_default, NULL },
    { "observeStatx", NULL, observe_statx, NULL, NULL, NULL, napi_default, NULL },
    { "observeExtended", NULL, observe_extended, NULL, NULL, NULL, napi_default, NULL },
    { "readAt", NULL, read_at, NULL, NULL, NULL, napi_default, NULL },
    { "readDirectory", NULL, read_directory, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, close_owner, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, sizeof(methods)/sizeof(methods[0]), methods) != napi_ok)
    return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
