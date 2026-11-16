/* #152 P0 Linux source-file bridge: opaque, owned, strictly read-only native FDs.
 * This is not a source-preservation qualification or a source-files manifest.
 */
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <linux/stat.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/sysmacros.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include <dirent.h>

#define MAX_PATH_BYTES 4096
#define MAX_READ_BYTES 65536
#define MAX_DIRECTORY_ENTRIES 4096

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
  napi_value text, error, code, syscall, number;
  if (napi_create_string_utf8(env, "Source-file native operation failed", NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_error(env, NULL, text, &error) != napi_ok ||
      napi_create_string_utf8(env, "ERR_SOURCE_NATIVE_IO", NAPI_AUTO_LENGTH, &code) != napi_ok ||
      napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &syscall) != napi_ok ||
      napi_create_int32(env, saved, &number) != napi_ok ||
      napi_set_named_property(env, error, "code", code) != napi_ok ||
      napi_set_named_property(env, error, "syscall", syscall) != napi_ok ||
      napi_set_named_property(env, error, "errno", number) != napi_ok) return NULL;
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
    { "readAt", NULL, read_at, NULL, NULL, NULL, napi_default, NULL },
    { "readDirectory", NULL, read_directory, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, close_owner, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, sizeof(methods)/sizeof(methods[0]), methods) != napi_ok)
    return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
