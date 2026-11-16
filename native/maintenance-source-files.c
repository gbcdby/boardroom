/* #152 P0: an opaque, real read-only source descriptor. No profile qualification. */
#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/openat2.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

struct source_owner { int fd; bool closed; bool uncertain; bool directory; };
struct linux_dirent64 { uint64_t ino; int64_t off; unsigned short reclen; unsigned char type; char name[]; };

static napi_value error(napi_env env, const char *code) {
  napi_value text, err; napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &text);
  napi_create_error(env, NULL, text, &err);
  napi_set_named_property(env, err, "code", text);
  napi_throw(env, err); return NULL;
}
static napi_value system_error(napi_env env, int code) {
  if (code == ELOOP) return error(env, "ERR_SOURCE_SYMLINK");
  if (code == EXDEV) return error(env, "ERR_SOURCE_CROSS_MOUNT");
  if (code == ENOSYS) return error(env, "ERR_SOURCE_UNSUPPORTED");
  if (code == ENOENT) return error(env, "ERR_SOURCE_MISSING");
  return error(env, "ERR_SOURCE_NATIVE");
}
static bool get_string(napi_env env, napi_value value, char *buffer, size_t cap, size_t *len) {
  size_t n = 0, copied = 0; napi_valuetype t;
  if (napi_typeof(env, value, &t) != napi_ok || t != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &n) != napi_ok || n == 0 || n >= cap ||
      napi_get_value_string_utf8(env, value, buffer, cap, &copied) != napi_ok || copied != n) return false;
  *len = n; return true;
}
static bool leaf_name(const char *s, size_t n) {
  return n > 0 && n <= 1024 && memchr(s, '/', n) == NULL && memchr(s, '\0', n) == NULL &&
    !(n == 1 && s[0] == '.') && !(n == 2 && s[0] == '.' && s[1] == '.');
}
static bool get_owner(napi_env env, napi_value value, struct source_owner **out) {
  struct source_owner *owner = NULL;
  if (napi_unwrap(env, value, (void **)&owner) != napi_ok || owner == NULL || owner->closed || owner->uncertain || owner->fd < 0)
    return false;
  *out = owner; return true;
}
static bool get_args(napi_env env, napi_callback_info cb, size_t expected, napi_value *args) {
  size_t count = expected;
  return napi_get_cb_info(env, cb, &count, args, NULL, NULL) == napi_ok && count == expected;
}
static int open_checked(int parent, const char *name, bool at_root) {
  struct open_how how = {0};
  how.flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (at_root ? O_DIRECTORY : 0);
  /* Root may itself be on a separate volume. Once pinned, children never cross it. */
  how.resolve = RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS |
    (at_root ? 0 : (RESOLVE_NO_XDEV | RESOLVE_BENEATH));
  return (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
}
static void finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  struct source_owner *owner = data;
  if (owner != NULL) { if (!owner->closed && owner->fd >= 0 && !owner->uncertain) (void)close(owner->fd); free(owner); }
}
static napi_value wrap_owner(napi_env env, int fd) {
  struct stat st;
  if (fstat(fd, &st) != 0) { int saved = errno; (void)close(fd); return system_error(env, saved); }
  if ((!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode)) || st.st_uid != getuid() ||
      (S_ISREG(st.st_mode) && st.st_nlink != 1)) { (void)close(fd); return error(env, "ERR_SOURCE_IDENTITY"); }
  struct source_owner *owner = calloc(1, sizeof(*owner));
  if (!owner) { (void)close(fd); return error(env, "ERR_SOURCE_NATIVE"); }
  owner->fd = fd; owner->directory = S_ISDIR(st.st_mode);
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok || napi_wrap(env, result, owner, finalize, NULL, NULL) != napi_ok) {
    (void)close(fd); free(owner); return error(env, "ERR_SOURCE_NATIVE");
  }
  return result;
}
static napi_value open_root(napi_env env, napi_callback_info cb) {
  napi_value args[1]; char file[4097]; size_t len;
  if (!get_args(env, cb, 1, args) || !get_string(env, args[0], file, sizeof(file), &len) || file[0] != '/' ||
      strstr(file, "/../") || strstr(file, "/./") || (len >= 3 && strcmp(file + len - 3, "/..") == 0) ||
      (len >= 2 && strcmp(file + len - 2, "/.") == 0)) return error(env, "ERR_SOURCE_ARGUMENT");
  int fd = open_checked(AT_FDCWD, file, true);
  if (fd < 0) return system_error(env, errno);
  return wrap_owner(env, fd);
}
static napi_value open_child(napi_env env, napi_callback_info cb) {
  napi_value args[2]; struct source_owner *parent; char name[1026]; size_t len;
  if (!get_args(env, cb, 2, args) || !get_owner(env, args[0], &parent)) return error(env, "ERR_SOURCE_CLOSED");
  if (!parent->directory || !get_string(env, args[1], name, sizeof(name), &len) || !leaf_name(name, len))
    return error(env, "ERR_SOURCE_ARGUMENT");
  int fd = open_checked(parent->fd, name, false);
  if (fd < 0) return system_error(env, errno);
  return wrap_owner(env, fd);
}
static void big(napi_env env, napi_value out, const char *key, int64_t n) {
  napi_value x; if (napi_create_bigint_int64(env, n, &x) == napi_ok) (void)napi_set_named_property(env, out, key, x);
}
static void big_u(napi_env env, napi_value out, const char *key, uint64_t n) {
  napi_value x; if (napi_create_bigint_uint64(env, n, &x) == napi_ok) (void)napi_set_named_property(env, out, key, x);
}
static napi_value observe(napi_env env, napi_callback_info cb) {
  napi_value args[1]; struct source_owner *owner;
  if (!get_args(env, cb, 1, args) || !get_owner(env, args[0], &owner)) return error(env, "ERR_SOURCE_CLOSED");
  struct stat st; struct statfs fs;
  if (fstat(owner->fd, &st) != 0 || fstatfs(owner->fd, &fs) != 0) return system_error(env, errno);
  napi_value result; if (napi_create_object(env, &result) != napi_ok) return error(env, "ERR_SOURCE_NATIVE");
  big_u(env, result, "dev", (uint64_t)st.st_dev); big_u(env, result, "ino", (uint64_t)st.st_ino);
  big_u(env, result, "mode", (uint64_t)st.st_mode); big_u(env, result, "uid", (uint64_t)st.st_uid);
  big_u(env, result, "gid", (uint64_t)st.st_gid); big_u(env, result, "nlink", (uint64_t)st.st_nlink);
  big(env, result, "size", (int64_t)st.st_size);
  big(env, result, "mtimeNs", (int64_t)st.st_mtim.tv_sec * 1000000000ll + st.st_mtim.tv_nsec);
  big(env, result, "ctimeNs", (int64_t)st.st_ctim.tv_sec * 1000000000ll + st.st_ctim.tv_nsec);
  big_u(env, result, "fsType", (uint64_t)fs.f_type); big_u(env, result, "fsBlockSize", (uint64_t)fs.f_bsize);
  napi_value kind;
  if (napi_create_string_utf8(env, owner->directory ? "directory" : "file", NAPI_AUTO_LENGTH, &kind) == napi_ok)
    (void)napi_set_named_property(env, result, "kind", kind);
  return result;
}
static napi_value read_at(napi_env env, napi_callback_info cb) {
  napi_value args[3]; struct source_owner *owner; bool lossless = false;
  uint64_t position = 0; uint32_t length = 0;
  if (!get_args(env, cb, 3, args) || !get_owner(env, args[0], &owner)) return error(env, "ERR_SOURCE_CLOSED");
  if (owner->directory || napi_get_value_bigint_uint64(env, args[1], &position, &lossless) != napi_ok || !lossless ||
      position > 9007199254740991ull || napi_get_value_uint32(env, args[2], &length) != napi_ok || length > 65536 ||
      position + length > 9007199254740991ull) return error(env, "ERR_SOURCE_ARGUMENT");
  unsigned char buffer[65536];
  ssize_t n = pread(owner->fd, buffer, length, (off_t)position);
  if (n < 0) return system_error(env, errno);
  napi_value result;
  if (napi_create_buffer_copy(env, (size_t)n, buffer, NULL, &result) != napi_ok) return error(env, "ERR_SOURCE_NATIVE");
  return result;
}
static napi_value read_directory(napi_env env, napi_callback_info cb) {
  napi_value args[1]; struct source_owner *owner;
  if (!get_args(env, cb, 1, args) || !get_owner(env, args[0], &owner)) return error(env, "ERR_SOURCE_CLOSED");
  if (!owner->directory) return error(env, "ERR_SOURCE_ARGUMENT");
  if (lseek(owner->fd, 0, SEEK_SET) != 0) return system_error(env, errno);
  napi_value result;
  if (napi_create_array(env, &result) != napi_ok) return error(env, "ERR_SOURCE_NATIVE");
  uint32_t index = 0; size_t bytes_total = 0;
  char buffer[32768];
  for (;;) {
    ssize_t n = syscall(SYS_getdents64, owner->fd, buffer, sizeof(buffer));
    if (n < 0) return system_error(env, errno);
    if (n == 0) break;
    size_t at = 0;
    while (at < (size_t)n) {
      if ((size_t)n - at < offsetof(struct linux_dirent64, name)) return error(env, "ERR_SOURCE_DIRECTORY");
      struct linux_dirent64 *entry = (void *)(buffer + at);
      const size_t base = offsetof(struct linux_dirent64, name);
      if (entry->reclen <= base || entry->reclen > (size_t)n - at) return error(env, "ERR_SOURCE_DIRECTORY");
      size_t capacity = entry->reclen - base;
      char *end = memchr(entry->name, '\0', capacity);
      if (!end) return error(env, "ERR_SOURCE_DIRECTORY");
      size_t len = (size_t)(end - entry->name);
      if (!((len == 1 && entry->name[0] == '.') || (len == 2 && entry->name[0] == '.' && entry->name[1] == '.'))) {
        bytes_total += len;
        if (index >= 4096 || bytes_total > 1048576 || len == 0) return error(env, "ERR_SOURCE_BUDGET");
        napi_value item, name, type;
        if (napi_create_object(env, &item) != napi_ok ||
            napi_create_buffer_copy(env, len, entry->name, NULL, &name) != napi_ok ||
            napi_create_uint32(env, (uint32_t)entry->type, &type) != napi_ok ||
            napi_set_named_property(env, item, "name", name) != napi_ok ||
            napi_set_named_property(env, item, "type", type) != napi_ok ||
            napi_set_element(env, result, index, item) != napi_ok) return error(env, "ERR_SOURCE_NATIVE");
        index++;
      }
      at += entry->reclen;
    }
  }
  return result;
}
static napi_value close_owner(napi_env env, napi_callback_info cb) {
  napi_value args[1]; struct source_owner *owner;
  if (!get_args(env, cb, 1, args) || !get_owner(env, args[0], &owner)) return error(env, "ERR_SOURCE_CLOSED");
  const int fd = owner->fd;
  if (close(fd) != 0) { owner->uncertain = true; return system_error(env, errno); }
  owner->closed = true; owner->fd = -1;
  napi_value result; if (napi_get_undefined(env, &result) != napi_ok) return error(env, "ERR_SOURCE_NATIVE");
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    {"openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL},
    {"openChild", NULL, open_child, NULL, NULL, NULL, napi_default, NULL},
    {"observe", NULL, observe, NULL, NULL, NULL, napi_default, NULL},
    {"readAt", NULL, read_at, NULL, NULL, NULL, napi_default, NULL},
    {"readDirectory", NULL, read_directory, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, close_owner, NULL, NULL, NULL, napi_default, NULL}
  };
  if (napi_define_properties(env, exports, sizeof(methods)/sizeof(*methods), methods) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
