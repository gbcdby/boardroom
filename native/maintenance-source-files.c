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
#include <linux/magic.h>
#include <limits.h>
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/sysmacros.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>
#include <dirent.h>

#define MAX_PATH_BYTES 4096
#define MAX_READ_BYTES 65536
#define MAX_DIRECTORY_ENTRIES 4096
#define MAX_FID_BYTES 128
#define MAX_XATTR_ENTRIES 64
#define MAX_XATTR_BYTES 65536
#define MAX_CONTEXT_BYTES (2U * 1024U * 1024U)
#define MAX_CONTEXT_CALLS 32768U
#define CONTEXT_CALL_RESERVE 2768U
#define MAX_CONTEXT_READS 256U
#define MAX_GRAPH_NODES 64U
#define MAX_GRAPH_EDGES 128U
#define MAX_GRAPH_NAMES 128U
#define MAX_GRAPH_DEPTH 16U
#ifndef STATX_MNT_ID_UNIQUE
#define STATX_MNT_ID_UNIQUE 0x00004000U
#endif

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

/* Local GET-only layouts from Linux v7.0 UAPI, with the accepted x86_64 ABI.
 * https://github.com/torvalds/linux/blob/v7.0/include/uapi/linux/ext4.h
 * https://github.com/torvalds/linux/blob/v7.0/include/uapi/linux/mount.h
 * https://github.com/torvalds/linux/blob/v7.0/arch/x86/entry/syscalls/syscall_64.tbl
 * Other architectures keep P0/P1/P2 and expose these new facts as abi unavailable. */
#if defined(__x86_64__) && !defined(__ILP32__)
#define P3_REVIEWED_UAPI 1
struct p3_tune {
  uint32_t set_flags, checkinterval;
  uint16_t errors_behavior, mnt_count, max_mnt_count, raid_stride;
  uint64_t last_check_time, reserved_blocks, blocks_count;
  uint32_t default_mnt_opts, reserved_uid, reserved_gid, raid_stripe_width;
  uint16_t encoding, encoding_flags; uint8_t def_hash_alg, pad_1; uint16_t pad_2;
  uint32_t feature_compat, feature_incompat, feature_ro_compat;
  uint32_t set_feature_compat_mask, set_feature_incompat_mask, set_feature_ro_compat_mask;
  uint32_t clear_feature_compat_mask, clear_feature_incompat_mask, clear_feature_ro_compat_mask;
  uint8_t mount_opts[64], pad[68];
};
struct p3_statmount {
  uint32_t size, mnt_opts; uint64_t mask; uint32_t sb_dev_major, sb_dev_minor;
  uint64_t sb_magic; uint32_t sb_flags, fs_type; uint64_t mnt_id, mnt_parent_id;
  uint32_t mnt_id_old, mnt_parent_id_old;
  uint64_t mnt_attr, mnt_propagation, mnt_peer_group, mnt_master, propagate_from;
  uint32_t mnt_root, mnt_point; uint64_t mnt_ns_id;
  uint32_t fs_subtype, sb_source, opt_num, opt_array, opt_sec_num, opt_sec_array;
  uint64_t supported_mask; uint32_t mnt_uidmap_num, mnt_uidmap, mnt_gidmap_num, mnt_gidmap;
  uint64_t spare[43];
};
struct p3_mnt_req { uint32_t size, mnt_ns_fd; uint64_t mnt_id, param, mnt_ns_id; };
#define P3_GET_TUNE _IOR('f', 45, struct p3_tune)
#ifndef SYS_statmount
#define SYS_statmount 457
#endif
_Static_assert(sizeof(struct p3_tune) == 232 && offsetof(struct p3_tune, default_mnt_opts) == 40 &&
  offsetof(struct p3_tune, feature_compat) == 64 && offsetof(struct p3_tune, mount_opts) == 100 &&
  P3_GET_TUNE == 0x80e8662dUL, "GET_TUNE exact reviewed ABI");
_Static_assert(sizeof(struct p3_statmount) == 512 && offsetof(struct p3_statmount, mnt_root) == 104 &&
  sizeof(struct p3_mnt_req) == 32 && SYS_statmount == 457, "statmount exact reviewed ABI");
#endif
_Static_assert(sizeof(struct statx) == 256, "statx UAPI size");

typedef struct {
  int fd;
  int parent_fd;
  bool directory;
  bool root;
  bool metadata_only;
  bool content_attempted;
  bool busy;
  bool tail;
  bool close_started;
  bool close_start_failed;
  bool invalid;
  bool close_unknown;
  bool parent_close_unknown;
  int close_error;
  int parent_close_error;
  struct stat initial;
  struct stat parent_initial;
  uint64_t legacy_mount_id;
  uint64_t unique_mount_id;
  char leaf[MAX_PATH_BYTES + 1];
  int unresolved_aux[256];
  size_t unresolved_aux_count;
} source_owner;

/* A JS shape or an unrelated napi_wrap object is not a source owner. */
static const napi_type_tag source_owner_tag = { UINT64_C(0x4a0ca487a98017e3), UINT64_C(0xbc820947cb34176d) };
static bool append_call(napi_env, napi_value, const char *, bool, int64_t, int);
static bool same_metadata(const struct stat *, const struct stat *);
static bool valid_metadata(const struct stat *, bool);
static napi_value extended_metadata(napi_env, const struct stat *, const struct statfs *, bool);

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
  napi_value roundtrip; bool identical = false;
  if (napi_create_string_utf8(env, output, bytes, &roundtrip) != napi_ok ||
      napi_strict_equals(env, value, roundtrip, &identical) != napi_ok || !identical) return false;
  return true;
}
static void owner_finalizer(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  source_owner *owner = data;
  /* If close returned an unknown result, never risk closing a recycled integer. */
  if (owner->fd >= 0 && !owner->close_unknown) (void)close(owner->fd);
  if (owner->parent_fd >= 0 && !owner->parent_close_unknown) (void)close(owner->parent_fd);
  free(owner);
}
static napi_value new_owner(napi_env env, source_owner **result) {
  source_owner *owner = calloc(1, sizeof(*owner));
  if (!owner) return throw_code(env, "ERR_SOURCE_ALLOC", "Source-file owner allocation failed");
  owner->fd = owner->parent_fd = -1;
  napi_value value;
  if (napi_create_object(env, &value) != napi_ok ||
      napi_type_tag_object(env, value, &source_owner_tag) != napi_ok ||
      napi_wrap(env, value, owner, owner_finalizer, NULL, NULL) != napi_ok) {
    free(owner);
    return throw_code(env, "ERR_SOURCE_ALLOC", "Source-file owner wrapping failed");
  }
  *result = owner;
  return value;
}
static bool lookup_owner(napi_env env, napi_value value, source_owner **out) {
  *out = NULL;
  bool tagged = false;
  return napi_check_object_type_tag(env, value, &source_owner_tag, &tagged) == napi_ok && tagged &&
    napi_unwrap(env, value, (void **)out) == napi_ok && *out;
}
static bool live_owner(napi_env env, napi_value value, source_owner **out) {
  return lookup_owner(env, value, out) && !(*out)->busy && (*out)->fd >= 0 && !(*out)->close_unknown &&
    !(*out)->parent_close_unknown && !(*out)->invalid;
}
static bool get_owner(napi_env env, napi_value value, source_owner **out) {
  return live_owner(env, value, out) && !(*out)->metadata_only;
}
static int close_slot(napi_env env, int *fd, bool *unknown, int *saved_error,
                      napi_value calls, const char *operation) {
  if (*fd < 0 || *unknown) return *saved_error;
  *unknown = true;
  errno = 0; const int rc = close(*fd), error = rc ? errno : 0;
  if (!append_call(env, calls, operation, true, rc, error)) {
    *saved_error = error ? error : EIO;
    if (!rc) { *fd = -1; *unknown = false; }
    return *saved_error;
  }
  if (!rc) { *fd = -1; *unknown = false; } else *saved_error = error;
  return error;
}
static int close_resources(napi_env env, source_owner *owner, napi_value calls) {
  owner->close_started = true;
  const int first = close_slot(env, &owner->parent_fd, &owner->parent_close_unknown,
    &owner->parent_close_error, calls, owner->tail ? "close-tail-carrier" : "close-bootstrap-parent");
  const int second = close_slot(env, &owner->fd, &owner->close_unknown,
    &owner->close_error, calls, owner->tail ? "close-tail-metadata" : "close-source");
  return first ? first : second ? second : owner->unresolved_aux_count ? EIO : 0;
}
static napi_value owner_error_calls(napi_env env, napi_value handle, source_owner *owner,
                              const char *code, const char *stage, int first_error, napi_value calls) {
  napi_value text, error, field;
  owner->invalid = true;
  if (!calls && napi_create_array(env, &calls) != napi_ok) return throw_code(env, code, "Source-file owner failed");
  const int cleanup = close_resources(env, owner, calls);
  if (napi_create_string_utf8(env, "Source-file owner failed", NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_error(env, NULL, text, &error) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &field) != napi_ok ||
      napi_set_named_property(env, error, "code", field) != napi_ok ||
      napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &field) != napi_ok ||
      napi_set_named_property(env, error, "syscall", field) != napi_ok ||
      napi_create_int32(env, first_error ? first_error : cleanup, &field) != napi_ok ||
      napi_set_named_property(env, error, "errno", field) != napi_ok ||
      napi_create_int32(env, -1, &field) != napi_ok || napi_set_named_property(env, error, "rc", field) != napi_ok ||
      napi_set_named_property(env, error, "cleanupCalls", calls) != napi_ok ||
      napi_set_named_property(env, error, "nativeCleanupOwner", handle) != napi_ok)
    return throw_code(env, code, "Could not encode source owner failure");
  (void)napi_throw(env, error); return NULL;
}
static napi_value owner_error(napi_env env, napi_value handle, source_owner *owner,
                              const char *code, const char *stage, int first_error) {
  return owner_error_calls(env, handle, owner, code, stage, first_error, NULL);
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
  how.flags = (uint64_t)(O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_NOATIME |
    (directory ? O_DIRECTORY : 0));
  how.resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | (root ? 0 : RESOLVE_BENEATH | RESOLVE_NO_XDEV);
  return (int)syscall(SYS_openat2, dir, name, &how, sizeof(how));
}
static bool mount_pair(int fd, const struct stat *st, uint64_t *legacy, uint64_t *unique) {
  struct statx old = {0}, current = {0};
  if (syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
      STATX_BASIC_STATS | STATX_MNT_ID, &old) != 0 ||
      syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
      STATX_BASIC_STATS | STATX_MNT_ID_UNIQUE, &current) != 0) return false;
  if (!(old.stx_mask & STATX_MNT_ID) || !(current.stx_mask & STATX_MNT_ID_UNIQUE) ||
      old.stx_ino != (uint64_t)st->st_ino || current.stx_ino != (uint64_t)st->st_ino ||
      old.stx_dev_major != major(st->st_dev) || old.stx_dev_minor != minor(st->st_dev) ||
      current.stx_dev_major != major(st->st_dev) || current.stx_dev_minor != minor(st->st_dev) ||
      !old.stx_mnt_id || !current.stx_mnt_id) { errno = ESTALE; return false; }
  *legacy = old.stx_mnt_id; *unique = current.stx_mnt_id; return true;
}
static napi_value open_root(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; char pathname[MAX_PATH_BYTES + 1];
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !string_arg(env, args[0], pathname, sizeof(pathname), false, true))
    return throw_code(env, "ERR_SOURCE_ARGUMENT", "Expected absolute source root");
  source_owner *owner; napi_value value = new_owner(env, &owner);
  if (!value) return NULL;
  owner->root = true; owner->metadata_only = true;
  struct open_how how = { .flags = O_PATH | O_CLOEXEC | O_NOFOLLOW,
    .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
  owner->fd = (int)syscall(SYS_openat2, AT_FDCWD, pathname, &how, sizeof(how));
  if (owner->fd < 0) return owner_error(env, value, owner, "ERR_SOURCE_NATIVE_IO", "openat2-root-metadata", errno);
  if (fstat(owner->fd, &owner->initial) != 0)
    return owner_error(env, value, owner, "ERR_SOURCE_NATIVE_IO", "fstat-root-metadata", errno);
  owner->directory = S_ISDIR(owner->initial.st_mode);
  if (!valid_metadata(&owner->initial, owner->directory))
    return owner_error(env, value, owner, "ERR_SOURCE_IDENTITY", "root-metadata-kind", ESTALE);
  if (owner->directory) {
    /* No owner has escaped this factory. Hold the metadata descriptor until
     * the distinct readable directory has been checked and it is closed. */
    owner->parent_fd = strict_openat(AT_FDCWD, pathname, true, true);
    if (owner->parent_fd < 0) return owner_error(env, value, owner, "ERR_SOURCE_NATIVE_IO", "openat2-root", errno);
    struct stat actual;
    if (fstat(owner->parent_fd, &actual) != 0)
      return owner_error(env, value, owner, "ERR_SOURCE_NATIVE_IO", "fstat-root", errno);
    if (!same_metadata(&owner->initial, &actual) || !valid_metadata(&actual, true))
      return owner_error(env, value, owner, "ERR_SOURCE_IDENTITY", "root-path-changed", ESTALE);
    napi_value calls;
    if (napi_create_array(env, &calls) != napi_ok) return owner_error(env, value, owner, "ERR_SOURCE_RESULT", "root-close-calls", EIO);
    int e = close_slot(env, &owner->fd, &owner->close_unknown, &owner->close_error, calls, "close-root-metadata");
    if (e) return owner_error_calls(env, value, owner, "ERR_SOURCE_NATIVE_IO", "close-root-metadata", e, calls);
    owner->fd = owner->parent_fd; owner->parent_fd = -1; owner->metadata_only = false;
    return value;
  }
  char *slash = strrchr(pathname, '/');
  if (!slash || !slash[1]) return owner_error(env, value, owner, "ERR_SOURCE_ARGUMENT", "root-leaf", EINVAL);
  memcpy(owner->leaf, slash + 1, strlen(slash + 1) + 1);
  if (slash == pathname) slash[1] = 0; else *slash = 0;
  owner->parent_fd = strict_openat(AT_FDCWD, pathname, true, true);
  if (owner->parent_fd < 0) return owner_error(env, value, owner, "ERR_SOURCE_NATIVE_IO", "openat2-bootstrap-parent", errno);
  struct stat path_stat;
  if (fstat(owner->parent_fd, &owner->parent_initial) != 0 ||
      fstatat(owner->parent_fd, owner->leaf, &path_stat, AT_SYMLINK_NOFOLLOW) != 0)
    return owner_error(env, value, owner, "ERR_SOURCE_NATIVE_IO", "bootstrap-parent-stat", errno);
  if (!valid_metadata(&owner->parent_initial, true) || !same_metadata(&owner->initial, &path_stat) ||
      owner->initial.st_dev != owner->parent_initial.st_dev)
    return owner_error(env, value, owner, "ERR_SOURCE_IDENTITY", "bootstrap-parent-binding", ESTALE);
  uint64_t legacy, unique;
  if (!mount_pair(owner->fd, &owner->initial, &owner->legacy_mount_id, &owner->unique_mount_id) ||
      !mount_pair(owner->parent_fd, &owner->parent_initial, &legacy, &unique))
    return owner_error(env, value, owner, "ERR_SOURCE_NATIVE_IO", "bootstrap-mount-pair", errno);
  if (legacy != owner->legacy_mount_id || unique != owner->unique_mount_id)
    return owner_error(env, value, owner, "ERR_SOURCE_IDENTITY", "bootstrap-parent-mount", ESTALE);
  return value;
}
static napi_value root_info(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1], result, field; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !live_owner(env, args[0], &owner) || !owner->root)
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected a live native root");
  struct stat st; struct statfs fs;
  if (fstat(owner->fd, &st) != 0 || fstatfs(owner->fd, &fs) != 0) return os_error(env, "root-info-stat");
  if (!valid_metadata(&st, owner->directory)) return throw_code(env, "ERR_SOURCE_IDENTITY", "Source root changed");
  napi_value metadata = extended_metadata(env, &st, &fs, owner->directory);
  if (!metadata) return NULL;
  if (napi_create_object(env, &result) != napi_ok || napi_create_uint32(env, 1, &field) != napi_ok ||
      napi_set_named_property(env, result, "abiVersion", field) != napi_ok ||
      napi_create_string_utf8(env, owner->directory ? "directory" : "file", NAPI_AUTO_LENGTH, &field) != napi_ok ||
      napi_set_named_property(env, result, "kind", field) != napi_ok ||
      napi_create_string_utf8(env, owner->metadata_only ? "metadata-only" : "readable", NAPI_AUTO_LENGTH, &field) != napi_ok ||
      napi_set_named_property(env, result, "stage", field) != napi_ok ||
      napi_set_named_property(env, result, "metadata", metadata) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot encode root info");
  return result;
}
static napi_value open_root_content(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *bootstrap;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !live_owner(env, args[0], &bootstrap) || !bootstrap->root || bootstrap->directory ||
      !bootstrap->metadata_only || bootstrap->content_attempted || bootstrap->parent_fd < 0)
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected unused native file bootstrap");
  bootstrap->content_attempted = true;
  struct stat before, parent, path_stat;
  if (fstat(bootstrap->fd, &before) != 0 || fstat(bootstrap->parent_fd, &parent) != 0 ||
      fstatat(bootstrap->parent_fd, bootstrap->leaf, &path_stat, AT_SYMLINK_NOFOLLOW) != 0) {
    bootstrap->invalid = true; return os_error(env, "root-content-before");
  }
  if (!same_metadata(&bootstrap->initial, &before) || !same_metadata(&before, &path_stat) ||
      !same_metadata(&bootstrap->parent_initial, &parent)) {
    bootstrap->invalid = true; return throw_code(env, "ERR_SOURCE_IDENTITY", "Root changed before content open");
  }
  source_owner *content; napi_value value = new_owner(env, &content);
  if (!value) { bootstrap->invalid = true; return NULL; }
  content->root = true;
  content->fd = strict_openat(bootstrap->parent_fd, bootstrap->leaf, false, false);
  if (content->fd < 0) {
    bootstrap->invalid = true;
    return owner_error(env, value, content, "ERR_SOURCE_NATIVE_IO", "openat2-root-content", errno);
  }
  struct stat actual, held, after_parent, after_path;
  uint64_t legacy = 0, unique = 0;
  int error = 0;
  if (fstat(content->fd, &actual) != 0 || fstat(bootstrap->fd, &held) != 0 ||
      fstat(bootstrap->parent_fd, &after_parent) != 0 ||
      fstatat(bootstrap->parent_fd, bootstrap->leaf, &after_path, AT_SYMLINK_NOFOLLOW) != 0) error = errno;
  else if (!valid_metadata(&actual, false) || !same_metadata(&before, &actual) ||
      !same_metadata(&before, &held) || !same_metadata(&before, &after_path) || !same_metadata(&parent, &after_parent)) error = ESTALE;
  else if (!mount_pair(content->fd, &actual, &legacy, &unique)) error = errno;
  else if (legacy != bootstrap->legacy_mount_id || unique != bootstrap->unique_mount_id) error = ESTALE;
  if (error) {
    bootstrap->invalid = true;
    return owner_error(env, value, content, error == ESTALE ? "ERR_SOURCE_IDENTITY" : "ERR_SOURCE_NATIVE_IO", "root-content-after", error);
  }
  content->initial = actual; content->legacy_mount_id = legacy; content->unique_mount_id = unique;
  content->parent_fd = fcntl(bootstrap->parent_fd, F_DUPFD_CLOEXEC, 0);
  if (content->parent_fd < 0)
    return owner_error(env, value, content, "ERR_SOURCE_NATIVE_IO", "retain-content-parent", errno);
  content->parent_initial = parent;
  memcpy(content->leaf, bootstrap->leaf, strlen(bootstrap->leaf) + 1);
  return value;
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
  source_owner *child; napi_value value = new_owner(env, &child);
  if (!value) return NULL;
  child->directory = directory; child->fd = strict_openat(parent->fd, name, directory, false);
  if (child->fd < 0) return owner_error(env, value, child, "ERR_SOURCE_NATIVE_IO", "openat2-child", errno);
  struct stat parent_after;
  if (fstat(child->fd, &child->initial) != 0 || fstat(parent->fd, &parent_after) != 0)
    return owner_error(env, value, child, "ERR_SOURCE_NATIVE_IO", "child-after-stat", errno);
  if (!valid_metadata(&child->initial, directory) || !valid_metadata(&parent_after, true))
    return owner_error(env, value, child, "ERR_SOURCE_IDENTITY", "child-after-identity", ESTALE);
  if (!directory) {
    child->parent_fd = fcntl(parent->fd, F_DUPFD_CLOEXEC, 0);
    if (child->parent_fd < 0)
      return owner_error(env, value, child, "ERR_SOURCE_NATIVE_IO", "retain-child-parent", errno);
    child->parent_initial = parent_after;
    memcpy(child->leaf, name, strlen(name) + 1);
  }
  return value;
}
/* An independent open description from the original retained parent. Never
 * dup the source file, follow /proc/self/fd, or accept an external descriptor. */
static napi_value reopen_file(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *original;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !get_owner(env, args[0], &original) || original->directory || original->parent_fd < 0 || !original->leaf[0])
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected live file with its original parent");
  struct stat held, parent, found;
  if (fstat(original->fd, &held) || fstat(original->parent_fd, &parent) ||
      fstatat(original->parent_fd, original->leaf, &found, AT_SYMLINK_NOFOLLOW)) return os_error(env, "reopen-before");
  if (!same_metadata(&original->initial, &held) || !same_metadata(&held, &found) ||
      !same_metadata(&original->parent_initial, &parent))
    return throw_code(env, "ERR_SOURCE_IDENTITY", "Source changed before independent reopen");
  source_owner *peer; napi_value result = new_owner(env, &peer);
  if (!result) return NULL;
  peer->root = original->root;
  peer->fd = strict_openat(original->parent_fd, original->leaf, false, original->root);
  if (peer->fd < 0) return owner_error(env, result, peer, "ERR_SOURCE_NATIVE_IO", "openat2-file-peer", errno);
  struct stat after, current_parent, current_path;
  if (fstat(peer->fd, &after) || fstat(original->parent_fd, &current_parent) ||
      fstatat(original->parent_fd, original->leaf, &current_path, AT_SYMLINK_NOFOLLOW))
    return owner_error(env, result, peer, "ERR_SOURCE_NATIVE_IO", "reopen-after", errno);
  if (!valid_metadata(&after, false) || !same_metadata(&held, &after) || !same_metadata(&held, &current_path) ||
      !same_metadata(&parent, &current_parent))
    return owner_error(env, result, peer, "ERR_SOURCE_IDENTITY", "reopen-binding", ESTALE);
  peer->parent_fd = fcntl(original->parent_fd, F_DUPFD_CLOEXEC, 0);
  if (peer->parent_fd < 0) return owner_error(env, result, peer, "ERR_SOURCE_NATIVE_IO", "retain-peer-parent", errno);
  peer->initial = after; peer->parent_initial = current_parent;
  memcpy(peer->leaf, original->leaf, strlen(original->leaf) + 1);
  return result;
}
static napi_value retain_metadata(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *source;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !get_owner(env, args[0], &source) || (!source->directory && source->parent_fd < 0))
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected actual source for metadata tail");
  source_owner *tail; napi_value result = new_owner(env, &tail);
  if (!result) return NULL;
  tail->tail = true; tail->root = true; tail->metadata_only = true; tail->directory = source->directory;
  struct open_how how = { .flags = O_PATH | O_CLOEXEC | O_NOFOLLOW,
    .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS |
      (source->root ? 0 : RESOLVE_BENEATH | RESOLVE_NO_XDEV) };
  tail->fd = (int)syscall(SYS_openat2, source->directory ? source->fd : source->parent_fd,
    source->directory ? "." : source->leaf, &how, sizeof(how));
  if (tail->fd < 0) return owner_error(env, result, tail, "ERR_SOURCE_NATIVE_IO", "openat2-tail-metadata", errno);
  struct stat current;
  if (fstat(tail->fd, &tail->initial) || fstat(source->fd, &current))
    return owner_error(env, result, tail, "ERR_SOURCE_NATIVE_IO", "tail-metadata-stat", errno);
  if (!same_metadata(&source->initial, &current) || !same_metadata(&current, &tail->initial))
    return owner_error(env, result, tail, "ERR_SOURCE_IDENTITY", "tail-metadata-binding", ESTALE);
  uint64_t legacy, unique;
  if (!mount_pair(tail->fd, &tail->initial, &tail->legacy_mount_id, &tail->unique_mount_id) ||
      !mount_pair(source->fd, &current, &legacy, &unique))
    return owner_error(env, result, tail, "ERR_SOURCE_NATIVE_IO", "tail-metadata-mount", errno);
  if (legacy != tail->legacy_mount_id || unique != tail->unique_mount_id)
    return owner_error(env, result, tail, "ERR_SOURCE_IDENTITY", "tail-metadata-mount", ESTALE);
  tail->parent_initial = source->directory ? current : source->parent_initial;
  if (!source->directory) memcpy(tail->leaf, source->leaf, strlen(source->leaf) + 1);
  return result;
}
/* The old directory owner loses its descriptor atomically on the JS thread.
 * This is a transfer, not close(), dup(), a late open, or evidence of release. */
static napi_value transfer_carrier(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2], result; source_owner *tail, *carrier;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2 ||
      !live_owner(env, args[0], &tail) || !tail->tail || tail->parent_fd >= 0 ||
      !get_owner(env, args[1], &carrier) || !carrier->directory || carrier->parent_fd >= 0)
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected live metadata tail and unique readable carrier");
  struct stat source, directory; uint64_t legacy, unique;
  if (fstat(tail->fd, &source) || fstat(carrier->fd, &directory)) return os_error(env, "tail-transfer-stat");
  if (!same_metadata(&tail->initial, &source) || !same_metadata(&tail->parent_initial, &directory) ||
      source.st_dev != directory.st_dev || !valid_metadata(&directory, true))
    return throw_code(env, "ERR_SOURCE_IDENTITY", "Tail carrier identity changed");
  if (!mount_pair(carrier->fd, &directory, &legacy, &unique)) return os_error(env, "tail-transfer-mount");
  if (legacy != tail->legacy_mount_id || unique != tail->unique_mount_id)
    return throw_code(env, "ERR_SOURCE_IDENTITY", "Tail carrier mount changed");
  if (!tail->directory) {
    struct stat found;
    if (fstatat(carrier->fd, tail->leaf, &found, AT_SYMLINK_NOFOLLOW)) return os_error(env, "tail-transfer-path");
    if (!same_metadata(&source, &found)) return throw_code(env, "ERR_SOURCE_IDENTITY", "Tail source path changed");
  }
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  tail->parent_fd = carrier->fd; carrier->fd = -1; carrier->invalid = true;
  return result;
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
static napi_value observe_statx_kind(napi_env env, napi_callback_info info, bool unique) {
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
              STATX_BASIC_STATS | STATX_BTIME | (unique ? STATX_MNT_ID_UNIQUE : STATX_MNT_ID), &facts) != 0)
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
  if ((facts.stx_mask & (unique ? STATX_MNT_ID_UNIQUE : STATX_MNT_ID)) != 0) {
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
  if (napi_set_named_property(env, object, unique ? "uniqueMountId" : "mountId", mount_id) != napi_ok ||
      napi_set_named_property(env, object, "birthtimeNs", birthtime) != napi_ok)
    return throw_code(env, "ERR_SOURCE_RESULT", "Cannot return source statx");
  return object;
}
static napi_value observe_statx(napi_env env, napi_callback_info info) { return observe_statx_kind(env, info, false); }
static napi_value observe_statx_unique(napi_env env, napi_callback_info info) { return observe_statx_kind(env, info, true); }

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

/* P3 is a fixed ordinary, read-only collector. It never decides qualification,
 * repairs a source, changes credentials, or accepts a caller's observation. */
typedef struct {
  napi_env env;
  source_owner *owner;
  napi_value auxiliary, graph_calls;
  size_t bytes, calls, changed_at, close_failed_at;
  int close_error;
  bool failed, budget_failed, graph_active, changed;
  int proc_fd, sys_fd, proc_owned, sys_owned;
  napi_value proc_calls, sys_calls;
} p3_context;
typedef struct {
  napi_value result, calls, value;
  const unsigned char *bytes;
  size_t length, read_count;
  bool ok;
  int open_error;
  const char *reason;
  struct stat st;
  struct statfs fs;
} p3_read;
typedef struct {
  napi_value result, calls, value;
  const char *reason;
  const void *bytes[2]; size_t length[2];
  int64_t numbers[3];
} p3_sample;
static void p3_changed(p3_context *c) {
  if (!c->changed) { c->changed = true; c->changed_at = c->calls; }
}
static napi_value p3_array(p3_context *c) {
  napi_value result = NULL;
  if (napi_create_array(c->env, &result) != napi_ok) c->failed = true;
  return result;
}
static bool p3_append(napi_env env, napi_value array, napi_value value) {
  uint32_t length;
  return array && value && napi_get_array_length(env, array, &length) == napi_ok &&
    napi_set_element(env, array, length, value) == napi_ok;
}
static void p3_call(p3_context *c, napi_value calls, const char *operation,
                    bool ran, int64_t rc, int error, bool auxiliary) {
  if (c->calls++ >= MAX_CONTEXT_CALLS || !calls || !append_call(c->env, calls, operation, ran, rc, error)) {
    c->failed = true; return;
  }
  uint32_t length; napi_value call;
  if (napi_get_array_length(c->env, calls, &length) != napi_ok ||
      napi_get_element(c->env, calls, length - 1, &call) != napi_ok) { c->failed = true; return; }
  if (auxiliary && calls != c->auxiliary && !p3_append(c->env, c->auxiliary, call)) c->failed = true;
  if (c->graph_active && c->graph_calls && calls != c->graph_calls && !p3_append(c->env, c->graph_calls, call)) c->failed = true;
}
static bool p3_room(p3_context *c) {
  if (c->budget_failed || c->calls >= MAX_CONTEXT_CALLS - CONTEXT_CALL_RESERVE || c->bytes > MAX_CONTEXT_BYTES) {
    c->budget_failed = true; return false;
  }
  return !c->failed && !c->owner->invalid;
}
static bool p3_account(p3_context *c, size_t bytes) {
  if (bytes > MAX_CONTEXT_BYTES - (c->bytes > MAX_CONTEXT_BYTES ? MAX_CONTEXT_BYTES : c->bytes)) {
    c->budget_failed = true; return false;
  }
  c->bytes += bytes; return true;
}
static void p3_phase_call(p3_context *c, napi_value calls, const char *operation,
                          bool after, bool ran, int64_t rc, int error, bool auxiliary) {
  char name[128]; snprintf(name, sizeof(name), "%s%s", operation, after ? "-after" : "");
  p3_call(c, calls, name, ran, rc, error, auxiliary);
}
static void p3_extend_calls(p3_context *c, napi_value target, napi_value source) {
  uint32_t length = 0; napi_value call;
  if (napi_get_array_length(c->env, source, &length) != napi_ok) { c->failed = true; return; }
  for (uint32_t i = 0; i < length; i++)
    if (napi_get_element(c->env, source, i, &call) != napi_ok || !p3_append(c->env, target, call)) c->failed = true;
}
static int p3_close(p3_context *c, int *fd, napi_value calls, const char *operation) {
  if (*fd < 0) { p3_call(c, calls, operation, false, 0, 0, true); return 0; }
  const int owned = *fd; *fd = -1;
  errno = 0; const int rc = close(owned), error = rc ? errno : 0;
  p3_call(c, calls, operation, true, rc, error, true);
  if (rc) {
    if (!c->close_failed_at) { c->close_failed_at = c->calls; c->close_error = error; }
    c->owner->invalid = true;
    if (c->owner->unresolved_aux_count < sizeof(c->owner->unresolved_aux) / sizeof(c->owner->unresolved_aux[0]))
      c->owner->unresolved_aux[c->owner->unresolved_aux_count++] = owned;
    else c->failed = true;
  }
  return error;
}
static bool p3_same_identity(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_mode == b->st_mode &&
    a->st_uid == b->st_uid && a->st_gid == b->st_gid && a->st_nlink == b->st_nlink;
}
static napi_value p3_identity(p3_context *c, const struct stat *st, const struct statfs *fs) {
  napi_value value = NULL;
  if (napi_create_object(c->env, &value) != napi_ok || !set_big(c->env, value, "device", st->st_dev) ||
      !set_big(c->env, value, "inode", st->st_ino) || !set_big(c->env, value, "mode", st->st_mode) ||
      !set_big(c->env, value, "filesystemType", (uint64_t)fs->f_type)) { c->failed = true; return NULL; }
  return value;
}
static bool p3_property(p3_context *c, napi_value object, const char *key, napi_value value) {
  if (!object || !value || napi_set_named_property(c->env, object, key, value) != napi_ok) { c->failed = true; return false; }
  return true;
}
static napi_value p3_bytes(p3_context *c, const void *bytes, size_t length) {
  napi_value value = NULL;
  if (napi_create_buffer_copy(c->env, length, bytes, NULL, &value) != napi_ok) c->failed = true;
  return value;
}
static napi_value p3_fact(p3_context *c, napi_value calls, napi_value value, const char *reason) {
  napi_value result = fact(c->env, calls, value, reason);
  if (!result) c->failed = true;
  return result;
}
static napi_value p3_missing(p3_context *c, const char *operation, const char *reason) {
  napi_value calls = p3_array(c);
  p3_call(c, calls, operation, false, 0, 0, false);
  return p3_fact(c, calls, NULL, reason);
}
static int p3_open_dir(p3_context *c, int base, const char *path, const char *operation,
                        napi_value calls, bool links) {
  if (base < 0 || !p3_room(c)) { p3_call(c, calls, operation, false, 0, 0, true); return -1; }
  struct open_how how = { .flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | (links ? 0 : RESOLVE_NO_SYMLINKS) };
  if (links) how.flags &= ~O_NOFOLLOW;
  errno = 0; const int fd = (int)syscall(SYS_openat2, base, path, &how, sizeof(how)); const int error = fd < 0 ? errno : 0;
  p3_call(c, calls, operation, true, fd, error, true); return fd;
}
static bool p3_dir_stat(p3_context *c, int fd, const char *stat_name, const char *fs_name,
                        napi_value calls, long magic, struct stat *st, struct statfs *fs) {
  bool ok = fd >= 0; int rc = -1, error = 0;
  if (fd >= 0) { errno = 0; rc = fstat(fd, st); error = rc ? errno : 0; }
  p3_call(c, calls, stat_name, fd >= 0, rc, error, true); ok = ok && rc == 0;
  if (fd >= 0) { errno = 0; rc = fstatfs(fd, fs); error = rc ? errno : 0; }
  p3_call(c, calls, fs_name, fd >= 0, rc, error, true);
  return ok && rc == 0 && S_ISDIR(st->st_mode) && (long)fs->f_type == magic;
}
static int p3_anchor(p3_context *c, const char *path, const char *label, long magic,
                     napi_value calls, int *owned) {
  char operation[80]; int fd = -1;
  snprintf(operation, sizeof(operation), "open-%s", label);
  if (p3_room(c)) {
    struct open_how how = { .flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW,
      .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    errno = 0; fd = (int)syscall(SYS_openat2, AT_FDCWD, path, &how, sizeof(how)); const int error = fd < 0 ? errno : 0;
    p3_call(c, calls, operation, true, fd, error, true);
  } else p3_call(c, calls, operation, false, 0, 0, true);
  char stat_name[80], fs_name[80]; struct stat st = {0}; struct statfs fs = {0};
  snprintf(stat_name, sizeof(stat_name), "fstat-%s", label); snprintf(fs_name, sizeof(fs_name), "fstatfs-%s", label);
  *owned = fd;
  return p3_dir_stat(c, fd, stat_name, fs_name, calls, magic, &st, &fs) ? fd : -1;
}
typedef enum { P3_KERNEL_GENERIC, P3_M04_SIZE, P3_M04_RO, P3_M04_DISKSEQ } p3_reader;
static const char *const p3_read_operations[][7] = {
  {"open-kernel-read", "fstat-kernel-before", "fstatfs-kernel-before", "read-kernel",
    "fstatfs-kernel-after", "fstat-kernel-after", "close-kernel-read"},
  {"open-block-size", "fstat-block-size-before", "fstatfs-block-size-before", "read-block-size",
    "fstatfs-block-size-after", "fstat-block-size-after", "close-block-size"},
  {"open-block-ro", "fstat-block-ro-before", "fstatfs-block-ro-before", "read-block-ro",
    "fstatfs-block-ro-after", "fstat-block-ro-after", "close-block-ro"},
  {"open-block-diskseq", "fstat-block-diskseq-before", "fstatfs-block-diskseq-before", "read-block-diskseq",
    "fstatfs-block-diskseq-after", "fstat-block-diskseq-after", "close-block-diskseq"},
};
static p3_read p3_kernel_read_phase(p3_context *c, int base, const char *path, size_t limit,
                                    long magic, bool second, size_t prior_reads, p3_reader reader) {
  p3_read out = { .calls = p3_array(c), .read_count = prior_reads };
  const char *const *operations = p3_read_operations[reader];
  const char *reason = NULL; int fd = -1, rc = -1, error = 0;
  unsigned char *data = NULL; size_t size = 0; bool eof = false;
  struct stat after = {0}; struct statfs fs_after = {0};
  if (base >= 0 && p3_room(c)) {
    struct open_how how = { .flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK,
      .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    errno = 0; fd = (int)syscall(SYS_openat2, base, path, &how, sizeof(how)); error = fd < 0 ? errno : 0;
    out.open_error = error;
    p3_phase_call(c, out.calls, operations[0], second, true, fd, error, true);
    if (fd < 0) reason = "syscall";
  } else {
    reason = c->budget_failed ? "budget" : "binding";
    p3_phase_call(c, out.calls, operations[0], second, false, 0, 0, true);
  }
  if (fd >= 0) { errno = 0; rc = fstat(fd, &out.st); error = rc ? errno : 0; }
  p3_phase_call(c, out.calls, operations[1], second, fd >= 0, rc, error, true);
  if (fd >= 0 && rc && !reason) reason = "syscall";
  if (fd >= 0) { errno = 0; rc = fstatfs(fd, &out.fs); error = rc ? errno : 0; }
  p3_phase_call(c, out.calls, operations[2], second, fd >= 0, rc, error, true);
  if (fd >= 0 && rc && !reason) reason = "syscall";
  if (!reason && (!S_ISREG(out.st.st_mode) || (long)out.fs.f_type != magic)) reason = "binding";
  if (!reason) {
    data = malloc(limit + 1);
    if (!data) reason = "budget";
  }
  bool ran = false;
  if (!reason) for (; out.read_count < MAX_CONTEXT_READS;) {
    if (!p3_room(c)) { reason = "budget"; break; }
    if (c->bytes == MAX_CONTEXT_BYTES) { c->budget_failed = true; reason = "budget"; break; }
    size_t amount = limit + 1 - size;
    if (amount > 16384) amount = 16384;
    if (amount > MAX_CONTEXT_BYTES - c->bytes) amount = MAX_CONTEXT_BYTES - c->bytes;
    errno = 0; const ssize_t got = read(fd, data + size, amount); error = got < 0 ? errno : 0;
    p3_phase_call(c, out.calls, operations[3], second, true, got, error, true);
    ran = true; out.read_count++;
    if (got < 0) { reason = "syscall"; break; }
    if ((size_t)got > amount) { reason = "length"; break; }
    if (!got) { eof = true; break; }
    size += (size_t)got; c->bytes += (size_t)got;
    if (size > limit || c->bytes > MAX_CONTEXT_BYTES) { reason = "budget"; break; }
  }
  if (!ran) p3_phase_call(c, out.calls, operations[3], second, false, 0, 0, true);
  if (!reason && !eof) reason = "budget";
  if (fd >= 0) { errno = 0; rc = fstatfs(fd, &fs_after); error = rc ? errno : 0; }
  p3_phase_call(c, out.calls, operations[4], second, fd >= 0, rc, error, true);
  if (fd >= 0 && rc && !reason) reason = "syscall";
  if (fd >= 0) { errno = 0; rc = fstat(fd, &after); error = rc ? errno : 0; }
  p3_phase_call(c, out.calls, operations[5], second, fd >= 0, rc, error, true);
  if (fd >= 0 && rc && !reason) reason = "syscall";
  if (!reason && (!p3_same_identity(&out.st, &after) || out.fs.f_type != fs_after.f_type)) {
    p3_changed(c); reason = "binding";
  }
  char close_name[128]; snprintf(close_name, sizeof(close_name), "%s%s", operations[6], second ? "-after" : "");
  const int ce = p3_close(c, &fd, out.calls, close_name);
  if (ce && !reason) reason = "syscall";
  if (!reason) {
    out.value = p3_identity(c, &out.st, &out.fs); napi_value bytes;
    void *copy = NULL;
    if (napi_create_buffer_copy(c->env, size, data, &copy, &bytes) != napi_ok || !p3_property(c, out.value, "bytes", bytes)) c->failed = true;
    out.bytes = copy; out.length = size; out.ok = !c->failed;
  }
  free(data);
  out.reason = reason ? reason : c->failed ? "budget" : NULL;
  out.result = p3_fact(c, out.calls, out.value, out.reason);
  return out;
}
static p3_read p3_kernel_read(p3_context *c, int base, const char *path, size_t limit, long magic) {
  return p3_kernel_read_phase(c, base, path, limit, magic, false, 0, P3_KERNEL_GENERIC);
}
static void p3_kernel_after_reader(p3_context *c, p3_read *first, int base, const char *path, size_t limit, long magic, p3_reader reader) {
  p3_read second = p3_kernel_read_phase(c, base, path, limit, magic, true, first->read_count, reader);
  p3_extend_calls(c, first->calls, second.calls);
  if ((first->ok && second.ok && (!p3_same_identity(&first->st, &second.st) ||
        first->fs.f_type != second.fs.f_type || first->length != second.length ||
        (first->length && memcmp(first->bytes, second.bytes, first->length)))) ||
      (first->ok && second.open_error == ENOENT) || (first->open_error == ENOENT && second.ok)) {
    p3_changed(c); first->reason = "binding";
  }
  if (!first->reason) first->reason = second.reason;
  first->ok = !first->reason; first->read_count = second.read_count;
  if (first->open_error != ENOENT || second.open_error != ENOENT) first->open_error = 0;
  first->result = p3_fact(c, first->calls, first->ok ? first->value : NULL, first->reason);
}
static void p3_kernel_after(p3_context *c, p3_read *first, int base, const char *path, size_t limit, long magic) {
  p3_kernel_after_reader(c, first, base, path, limit, magic, P3_KERNEL_GENERIC);
}
static bool p3_mb_literal(const unsigned char **cursor, const unsigned char *end, const char *literal) {
  const size_t length = strlen(literal);
  if ((size_t)(end - *cursor) < length || memcmp(*cursor, literal, length)) return false;
  *cursor += length; return true;
}
static bool p3_mb_decimal(const unsigned char **cursor, const unsigned char *end) {
  if (*cursor >= end) return false;
  uint32_t value = 0;
  if (**cursor == '0') (*cursor)++;
  else {
    if (**cursor < '1' || **cursor > '9') return false;
    do {
      const unsigned digit = *(*cursor)++ - '0';
      if (value > (UINT32_MAX - digit) / 10) return false;
      value = value * 10 + digit;
    } while (*cursor < end && **cursor >= '0' && **cursor <= '9');
  }
  if (*cursor >= end || **cursor != '\n') return false;
  (*cursor)++; return true;
}
static bool p3_mb_summary_bit(const p3_read *read, unsigned *bit) {
  if (!read->ok || !read->length || read->length > 16384 || read->bytes[read->length - 1] != '\n') return false;
  const unsigned char *cursor = read->bytes, *end = read->bytes + read->length;
  if (!p3_mb_literal(&cursor, end, "optimize_scan: ") || cursor >= end || (*cursor != '0' && *cursor != '1')) return false;
  *bit = *cursor++ - '0';
  if (!p3_mb_literal(&cursor, end, "\n")) return false;
  for (unsigned section = 0; section < 2; section++) {
    if (!p3_mb_literal(&cursor, end, section ? "avg_fragment_size_lists:\n" : "max_free_order_lists:\n")) return false;
    for (unsigned order = 0; order < 14; order++) {
      char label[64]; snprintf(label, sizeof(label), "\tlist_order_%u_groups: ", order);
      if (!p3_mb_literal(&cursor, end, label) || !p3_mb_decimal(&cursor, end)) return false;
    }
  }
  return cursor == end;
}
static void p3_mb_summary_after(p3_context *c, p3_read *first, int base) {
  p3_read second = p3_kernel_read_phase(c, base, "mb_structs_summary", 16384, PROC_SUPER_MAGIC, true,
    first->read_count, P3_KERNEL_GENERIC);
  p3_extend_calls(c, first->calls, second.calls);
  if ((first->ok && second.ok && (!p3_same_identity(&first->st, &second.st) || first->fs.f_type != second.fs.f_type)) ||
      (first->ok && second.open_error == ENOENT) || (first->open_error == ENOENT && second.ok)) {
    p3_changed(c); first->reason = "binding";
  }
  if (first->ok && second.ok && !first->reason) {
    unsigned before_bit = 0, after_bit = 0;
    const bool before_valid = p3_mb_summary_bit(first, &before_bit), after_valid = p3_mb_summary_bit(&second, &after_bit);
    if (before_valid != after_valid || (before_valid && before_bit != after_bit)) {
      p3_changed(c); first->reason = "binding";
    } else if (!before_valid) first->reason = "format";
  }
  if (!first->reason) first->reason = second.reason;
  first->ok = !first->reason; first->read_count = second.read_count;
  if (first->open_error != ENOENT || second.open_error != ENOENT) first->open_error = 0;
  first->result = p3_fact(c, first->calls, first->ok ? first->value : NULL, first->reason);
}
/* No caller-selected path, descriptor, node, read limit or magic enters these
 * readers. The supplied base is the original source-derived node zero FD. */
static const char *p3_block_leaf(p3_reader reader) {
  switch (reader) {
    case P3_M04_SIZE: return "size";
    case P3_M04_RO: return "ro";
    case P3_M04_DISKSEQ: return "diskseq";
    default: return NULL;
  }
}
static p3_read p3_block_before(p3_context *c, int base, p3_reader reader) {
  return p3_kernel_read_phase(c, base, p3_block_leaf(reader), 4096, SYSFS_MAGIC, false, 0, reader);
}
static void p3_block_after(p3_context *c, p3_read *first, int base, p3_reader reader) {
  p3_kernel_after_reader(c, first, base, p3_block_leaf(reader), 4096, SYSFS_MAGIC, reader);
}
static napi_value p3_sample_result(p3_context *c, p3_sample *sample) {
  sample->result = p3_fact(c, sample->calls, sample->reason ? NULL : sample->value, sample->reason);
  return sample->result;
}
static bool p3_sample_bytes(p3_context *c, p3_sample *sample, unsigned index,
                            const void *data, size_t size, napi_value *buffer) {
  void *copy = NULL;
  if (index > 1 || !p3_account(c, size)) { sample->reason = "budget"; return false; }
  if (napi_create_buffer_copy(c->env, size, data, &copy, buffer) != napi_ok) { c->failed = true; return false; }
  sample->bytes[index] = copy; sample->length[index] = size; return true;
}
static napi_value p3_sample_join(p3_context *c, p3_sample *first, const p3_sample *second) {
  p3_extend_calls(c, first->calls, second->calls);
  if (!first->reason && !second->reason) {
    bool same = !memcmp(first->numbers, second->numbers, sizeof(first->numbers));
    for (unsigned i = 0; i < 2; i++) same = same && first->length[i] == second->length[i] &&
      (!first->length[i] || !memcmp(first->bytes[i], second->bytes[i], first->length[i]));
    if (!same) { p3_changed(c); first->reason = "binding"; }
  }
  if (!first->reason) first->reason = second->reason;
  return p3_sample_result(c, first);
}
static p3_sample p3_statx_fact(p3_context *c, int fd, const struct stat *source, bool unique,
                               struct statx *raw, bool *available, bool after) {
  p3_sample out = { .calls = p3_array(c) }; *available = false; memset(raw, 0, sizeof(*raw));
  const char *operation = unique ? "statx-unique" : "statx-legacy";
  if (fd < 0 || !p3_room(c)) {
    p3_phase_call(c, out.calls, operation, after, false, 0, 0, false);
    out.reason = c->budget_failed ? "budget" : "binding";
  } else {
    errno = 0; const long rc = syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
      STATX_BASIC_STATS | STATX_BTIME | (unique ? STATX_MNT_ID_UNIQUE : STATX_MNT_ID), raw); const int error = rc ? errno : 0;
    p3_phase_call(c, out.calls, operation, after, true, rc, error, false);
    if (rc) out.reason = "syscall";
    else if ((raw->stx_mask & STATX_BASIC_STATS) != STATX_BASIC_STATS || raw->stx_ino != source->st_ino ||
        raw->stx_dev_major != major(source->st_dev) || raw->stx_dev_minor != minor(source->st_dev) ||
        raw->stx_mode != source->st_mode || raw->stx_uid != source->st_uid || raw->stx_gid != source->st_gid ||
        raw->stx_nlink != source->st_nlink || raw->stx_size != (uint64_t)source->st_size) out.reason = "binding";
    else if (p3_sample_bytes(c, &out, 0, raw, sizeof(*raw), &out.value)) *available = true;
  }
  (void)p3_sample_result(c, &out); return out;
}
static p3_sample p3_statmount_fact(p3_context *c, const struct statx *unique, bool available, bool after) {
  p3_sample out = { .calls = p3_array(c) };
#ifdef P3_REVIEWED_UAPI
  if (!available || !(unique->stx_mask & STATX_MNT_ID_UNIQUE) || !unique->stx_mnt_id || !p3_room(c)) {
    p3_phase_call(c, out.calls, "statmount", after, false, 0, 0, false);
    out.reason = c->budget_failed ? "budget" : "binding";
  } else {
    struct p3_mnt_req request = { .size = sizeof(request), .mnt_id = unique->stx_mnt_id, .param = 0x3b };
    union { max_align_t alignment; unsigned char bytes[16384]; } raw = {0};
    errno = 0; const long rc = syscall(SYS_statmount, &request, raw.bytes, sizeof(raw.bytes), 0U); const int error = rc ? errno : 0;
    p3_phase_call(c, out.calls, "statmount", after, true, rc, error, false);
    const struct p3_statmount *header = (const void *)raw.bytes;
    if (rc) out.reason = "syscall";
    else if (header->size < sizeof(*header) || header->size > sizeof(raw.bytes)) out.reason = "length";
    else {
      napi_value request_value = NULL, result_value = NULL;
      if (napi_create_object(c->env, &out.value) != napi_ok) c->failed = true;
      if (p3_sample_bytes(c, &out, 0, &request, sizeof(request), &request_value))
        (void)p3_property(c, out.value, "request", request_value);
      if (p3_sample_bytes(c, &out, 1, raw.bytes, header->size, &result_value))
        (void)p3_property(c, out.value, "result", result_value);
    }
  }
#else
  (void)unique; (void)available;
  p3_phase_call(c, out.calls, "statmount", after, false, 0, 0, false); out.reason = "abi";
#endif
  (void)p3_sample_result(c, &out); return out;
}
static p3_sample p3_tune_fact(p3_context *c, int fd, bool after) {
  p3_sample out = { .calls = p3_array(c) };
#ifdef P3_REVIEWED_UAPI
  if (fd < 0 || !p3_room(c)) {
    p3_phase_call(c, out.calls, "ioctl-get-tune", after, false, 0, 0, false);
    out.reason = c->budget_failed ? "budget" : "binding";
  } else {
    struct p3_tune value = {0};
    errno = 0; const int rc = ioctl(fd, P3_GET_TUNE, &value), error = rc ? errno : 0;
    p3_phase_call(c, out.calls, "ioctl-get-tune", after, true, rc, error, false);
    if (rc) out.reason = "syscall";
    else (void)p3_sample_bytes(c, &out, 0, &value, sizeof(value), &out.value);
  }
#else
  (void)fd; p3_phase_call(c, out.calls, "ioctl-get-tune", after, false, 0, 0, false); out.reason = "abi";
#endif
  (void)p3_sample_result(c, &out); return out;
}
static bool p3_status_ids(const p3_read *status, const char *label, uint32_t values[4]) {
  if (!status->ok) return false;
  const size_t label_size = strlen(label); bool found = false;
  for (size_t at = 0; at < status->length;) {
    const unsigned char *end = memchr(status->bytes + at, '\n', status->length - at);
    if (!end) return false;
    size_t length = (size_t)(end - status->bytes) - at;
    if (length >= label_size && !memcmp(status->bytes + at, label, label_size)) {
      if (found) return false;
      found = true; size_t p = at + label_size;
      for (unsigned i = 0; i < 4; i++) {
        if (p == (size_t)(end - status->bytes) || (status->bytes[p] != ' ' && status->bytes[p] != '\t')) return false;
        while (p < (size_t)(end - status->bytes) && (status->bytes[p] == ' ' || status->bytes[p] == '\t')) p++;
        uint64_t n = 0; size_t start = p;
        while (p < (size_t)(end - status->bytes) && status->bytes[p] >= '0' && status->bytes[p] <= '9') {
          n = n * 10 + status->bytes[p++] - '0'; if (n > UINT32_MAX) return false;
        }
        if (p == start) return false;
        values[i] = (uint32_t)n;
      }
      if (p != (size_t)(end - status->bytes)) return false;
    }
    at += length + 1;
  }
  return found;
}
typedef struct {
  napi_value calls; const char *reason; pid_t pid, tid;
  uid_t uid[3]; gid_t gid[3], groups[256];
  uint32_t status_uid[4], status_gid[4]; int count, nnp;
} p3_credentials;
static void p3_identity_before(p3_context *c, p3_credentials *id, p3_read *status, p3_read *process_stat) {
  id->calls = p3_array(c); napi_value calls = id->calls; const char *reason = NULL;
  id->pid = getpid(); p3_call(c, calls, "getpid", true, id->pid, 0, false);
  errno = 0; const long thread = syscall(SYS_gettid); const int te = thread < 0 ? errno : 0;
  p3_call(c, calls, "gettid", true, thread, te, false); id->tid = thread > 0 && thread <= INT_MAX ? (pid_t)thread : 0;
  if (id->pid <= 0 || !id->tid) reason = "syscall";
  char path[96]; snprintf(path, sizeof(path), "%d/task/%d/status", id->pid, id->tid);
  *status = p3_kernel_read(c, reason ? -1 : c->proc_fd, path, 65536, PROC_SUPER_MAGIC);
  snprintf(path, sizeof(path), "%d/stat", id->pid);
  *process_stat = p3_kernel_read(c, reason ? -1 : c->proc_fd, path, 8192, PROC_SUPER_MAGIC);
  int got = -1;
  errno = 0; int rc = getresuid(&id->uid[0], &id->uid[1], &id->uid[2]), error = rc ? errno : 0;
  p3_call(c, calls, "getresuid", true, rc, error, false); if (rc && !reason) reason = "syscall";
  errno = 0; rc = getresgid(&id->gid[0], &id->gid[1], &id->gid[2]); error = rc ? errno : 0;
  p3_call(c, calls, "getresgid", true, rc, error, false); if (rc && !reason) reason = "syscall";
  errno = 0; id->count = getgroups(0, NULL); error = id->count < 0 ? errno : 0;
  p3_call(c, calls, "getgroups-count", true, id->count, error, false);
  if (id->count >= 0 && id->count <= 256) { errno = 0; got = getgroups(id->count, id->groups); error = got < 0 ? errno : 0; }
  p3_call(c, calls, "getgroups", id->count >= 0 && id->count <= 256, got, error, false);
  if (id->count > 256 && !reason) reason = "budget";
  if ((id->count < 0 || got < 0) && !reason) reason = "syscall";
  if (got != id->count && !reason) reason = "binding";
  errno = 0; id->nnp = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0); error = id->nnp < 0 ? errno : 0;
  p3_call(c, calls, "prctl-get-no-new-privs", true, id->nnp, error, false); if (id->nnp < 0 && !reason) reason = "syscall";
  if (!reason && (!p3_status_ids(status, "Uid:", id->status_uid) || !p3_status_ids(status, "Gid:", id->status_gid))) reason = "binding";
  for (unsigned i = 0; !reason && i < 3; i++) if (id->status_uid[i] != id->uid[i] || id->status_gid[i] != id->gid[i]) reason = "binding";
  id->reason = reason;
}
static napi_value p3_identity_after(p3_context *c, p3_credentials *id) {
  napi_value calls = id->calls; const char *reason = id->reason;
  uid_t ua[3] = {0}; gid_t ga[3] = {0}, after_groups[256] = {0};
  int after_count = -1, after_got = -1, after_nnp = -1, rc, error;
  errno = 0; rc = getresuid(&ua[0], &ua[1], &ua[2]); error = rc ? errno : 0;
  p3_call(c, calls, "getresuid-after", true, rc, error, false); if (rc && !reason) reason = "syscall";
  errno = 0; rc = getresgid(&ga[0], &ga[1], &ga[2]); error = rc ? errno : 0;
  p3_call(c, calls, "getresgid-after", true, rc, error, false); if (rc && !reason) reason = "syscall";
  errno = 0; after_count = getgroups(0, NULL); error = after_count < 0 ? errno : 0;
  p3_call(c, calls, "getgroups-count-after", true, after_count, error, false);
  if (after_count >= 0 && after_count <= 256) { errno = 0; after_got = getgroups(after_count, after_groups); error = after_got < 0 ? errno : 0; }
  p3_call(c, calls, "getgroups-after", after_count >= 0 && after_count <= 256, after_got, error, false);
  if (after_count > 256 && !reason) reason = "budget";
  if ((after_count < 0 || after_got < 0) && !reason) reason = "syscall";
  errno = 0; after_nnp = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0); error = after_nnp < 0 ? errno : 0;
  p3_call(c, calls, "prctl-get-no-new-privs-after", true, after_nnp, error, false);
  if (after_nnp < 0 && !reason) reason = "syscall";
  if (!reason && (memcmp(id->uid, ua, sizeof(ua)) || memcmp(id->gid, ga, sizeof(ga)) || after_got != after_count ||
      id->count != after_count || id->nnp != after_nnp || memcmp(id->groups, after_groups, (size_t)id->count * sizeof(gid_t)))) {
    p3_changed(c); reason = "binding";
  }
  napi_value value = NULL;
  if (!reason) {
    napi_value uids = p3_array(c), gids = p3_array(c), gs = p3_array(c), n;
    if (napi_create_object(c->env, &value) != napi_ok || !set_big(c->env, value, "pid", id->pid) ||
        !set_big(c->env, value, "tid", id->tid) || !set_big(c->env, value, "noNewPrivileges", id->nnp)) c->failed = true;
    for (unsigned i = 0; i < 4; i++) {
      if (napi_create_bigint_uint64(c->env, id->status_uid[i], &n) != napi_ok || !p3_append(c->env, uids, n)) c->failed = true;
      if (napi_create_bigint_uint64(c->env, id->status_gid[i], &n) != napi_ok || !p3_append(c->env, gids, n)) c->failed = true;
    }
    for (int i = 0; i < id->count; i++) if (napi_create_bigint_uint64(c->env, id->groups[i], &n) != napi_ok || !p3_append(c->env, gs, n)) c->failed = true;
    (void)p3_property(c, value, "uid", uids); (void)p3_property(c, value, "gid", gids); (void)p3_property(c, value, "groups", gs);
  }
  return p3_fact(c, calls, value, reason);
}
typedef struct { struct stat st[3]; struct statfs fs[3]; unsigned char raw[3][128]; size_t size[3]; bool ok; } p3_namespaces;
static napi_value p3_namespace_pass(p3_context *c, pid_t pid, pid_t tid, bool after,
                                    p3_namespaces *out, napi_value calls) {
  const char *names[] = {"pid", "mount", "user"}, *leaves[] = {"pid", "mnt", "user"};
  napi_value value = NULL; if (napi_create_object(c->env, &value) != napi_ok) c->failed = true;
  out->ok = true;
  for (unsigned i = 0; i < 3; i++) {
    char path[128], operation[80]; const char *suffix = after ? "-after" : "";
    snprintf(path, sizeof(path), "%d/task/%d/ns/%s", pid, tid, leaves[i]);
    int fd = -1, rc = -1, error = 0; bool ok = c->proc_fd >= 0 && pid > 0 && tid > 0 && p3_room(c);
    if (ok) { errno = 0; fd = openat(c->proc_fd, path, O_RDONLY | O_CLOEXEC); error = fd < 0 ? errno : 0; }
    snprintf(operation, sizeof(operation), "open-namespace-%s%s", names[i], suffix);
    p3_call(c, calls, operation, ok, fd, error, true); ok = ok && fd >= 0;
    if (fd >= 0) { errno = 0; rc = fstat(fd, &out->st[i]); error = rc ? errno : 0; }
    snprintf(operation, sizeof(operation), "fstat-namespace-%s%s", names[i], suffix);
    p3_call(c, calls, operation, fd >= 0, rc, error, true); ok = ok && rc == 0;
    if (fd >= 0) { errno = 0; rc = fstatfs(fd, &out->fs[i]); error = rc ? errno : 0; }
    snprintf(operation, sizeof(operation), "fstatfs-namespace-%s%s", names[i], suffix);
    p3_call(c, calls, operation, fd >= 0, rc, error, true);
    ok = ok && rc == 0 && (long)out->fs[i].f_type == NSFS_MAGIC;
    ssize_t got = -1; size_t capacity = MAX_CONTEXT_BYTES - c->bytes;
    if (capacity > sizeof(out->raw[i])) capacity = sizeof(out->raw[i]);
    bool ran = ok && capacity > 0;
    if (ok && !capacity) c->budget_failed = true;
    if (ran) { errno = 0; got = readlinkat(c->proc_fd, path, (char *)out->raw[i], capacity); error = got < 0 ? errno : 0; }
    snprintf(operation, sizeof(operation), "readlink-namespace-%s%s", names[i], suffix);
    p3_call(c, calls, operation, ran, got, error, true);
    if (got > 0 && !p3_account(c, (size_t)got)) ok = false;
    ok = ok && got > 0 && (size_t)got < capacity;
    if (ok) out->size[i] = (size_t)got;
    snprintf(operation, sizeof(operation), "close-namespace-%s%s", names[i], suffix);
    if (p3_close(c, &fd, calls, operation)) ok = false;
    if (ok) {
      napi_value item = p3_identity(c, &out->st[i], &out->fs[i]);
      (void)p3_property(c, item, "bytes", p3_bytes(c, out->raw[i], out->size[i])); (void)p3_property(c, value, names[i], item);
    } else out->ok = false;
  }
  return value;
}
static napi_value p3_uname_fact(p3_context *c) {
  napi_value calls = p3_array(c); struct utsname raw = {0};
  errno = 0; const int rc = uname(&raw), error = rc ? errno : 0;
  p3_call(c, calls, "uname", true, rc, error, false);
  const char *reason = rc ? "syscall" : !p3_account(c, sizeof(raw)) ? "budget" : NULL;
  return p3_fact(c, calls, reason ? NULL : p3_bytes(c, &raw, sizeof(raw)), reason);
}
static bool p3_decimal_line(const p3_read *r, uint64_t maximum, uint64_t *value) {
  if (!r->ok || r->length < 2 || r->bytes[r->length - 1] != '\n' || r->length > 21) return false;
  if (r->length > 2 && r->bytes[0] == '0') return false;
  uint64_t n = 0;
  for (size_t i = 0; i + 1 < r->length; i++) {
    if (r->bytes[i] < '0' || r->bytes[i] > '9' || n > (maximum - (r->bytes[i] - '0')) / 10) return false;
    n = n * 10 + r->bytes[i] - '0';
  }
  *value = n; return true;
}
static p3_sample p3_ioprio_fact(p3_context *c, const p3_read *journal, bool after) {
  p3_sample out = { .calls = p3_array(c) }; uint64_t pid = 0;
#ifdef SYS_ioprio_get
  if (!p3_decimal_line(journal, INT_MAX, &pid) || !pid || !p3_room(c)) {
    p3_phase_call(c, out.calls, "ioprio-get", after, false, 0, 0, false);
    out.reason = c->budget_failed ? "budget" : "binding";
  } else {
    errno = 0; const long rc = syscall(SYS_ioprio_get, 1, (int)pid); const int error = rc < 0 ? errno : 0;
    p3_phase_call(c, out.calls, "ioprio-get", after, true, rc, error, false);
    if (rc < 0) out.reason = "syscall";
    else {
      out.numbers[0] = 1; out.numbers[1] = (int64_t)pid; out.numbers[2] = rc;
      if (napi_create_object(c->env, &out.value) != napi_ok || !set_big(c->env, out.value, "which", 1) ||
          !set_big(c->env, out.value, "who", pid) || !set_int(c->env, out.value, "rawValue", rc)) c->failed = true;
    }
  }
#else
  (void)journal; (void)pid; p3_phase_call(c, out.calls, "ioprio-get", after, false, 0, 0, false); out.reason = "abi";
#endif
  (void)p3_sample_result(c, &out); return out;
}
/* Linux getdents64 record: the actual bounded bytes are validated before any
 * name is used. Only native sysfs names select further fixed relative reads. */
struct p3_dirent64 { uint64_t inode; int64_t offset; uint16_t length; uint8_t type; char name[]; };
_Static_assert(offsetof(struct p3_dirent64, name) == 19, "getdents64 name layout");
typedef struct {
  char names[MAX_GRAPH_NAMES][256]; unsigned char types[MAX_GRAPH_NAMES];
  unsigned char partition_presence[MAX_GRAPH_NAMES]; struct stat partition_identity[MAX_GRAPH_NAMES];
  size_t count, read_count; bool ok; napi_value value;
} p3_names;
static bool p3_name(const unsigned char *name, size_t size) {
  if (!size || size > 255 || (size == 1 && name[0] == '.') || (size == 2 && !memcmp(name, "..", 2))) return false;
  for (size_t i = 0; i < size; i++) if (name[i] < 0x21 || name[i] > 0x7e || name[i] == '/') return false;
  return true;
}
static p3_names *p3_enumerate(p3_context *c, int parent, const char *path, const char *resource,
                             napi_value calls, bool second, size_t prior_reads) {
  p3_names *out = calloc(1, sizeof(*out));
  if (!out) { c->failed = true; return NULL; }
  out->value = p3_array(c); out->read_count = prior_reads;
  char operation[96], stat_name[96], fs_name[96]; const char *suffix = second ? "-after" : "";
  snprintf(operation, sizeof(operation), "open-%s%s", resource, suffix);
  int fd = p3_open_dir(c, parent, path, operation, calls, false);
  struct stat before = {0}, after = {0}; struct statfs fs = {0}, fs_after = {0};
  snprintf(stat_name, sizeof(stat_name), "fstat-%s-before%s", resource, suffix); snprintf(fs_name, sizeof(fs_name), "fstatfs-%s-before%s", resource, suffix);
  bool ok = p3_dir_stat(c, fd, stat_name, fs_name, calls, SYSFS_MAGIC, &before, &fs), eof = false, ran = false;
  union { max_align_t alignment; unsigned char bytes[16384]; } raw;
  snprintf(operation, sizeof(operation), "getdents-%s%s", resource, suffix);
#ifdef SYS_getdents64
  for (; ok && out->read_count < MAX_CONTEXT_READS;) {
    if (!p3_room(c)) { ok = false; break; }
    size_t capacity = MAX_CONTEXT_BYTES - c->bytes;
    if (!capacity) { c->budget_failed = true; ok = false; break; }
    if (capacity > sizeof(raw.bytes)) capacity = sizeof(raw.bytes);
    errno = 0; long got = syscall(SYS_getdents64, fd, raw.bytes, capacity); const int error = got < 0 ? errno : 0;
    p3_call(c, calls, operation, true, got, error, true); ran = true; out->read_count++;
    if (got < 0 || (size_t)got > capacity) { ok = false; break; }
    if (!got) { eof = true; break; }
    c->bytes += (size_t)got;
    if (c->bytes > MAX_CONTEXT_BYTES) { c->budget_failed = true; ok = false; break; }
    for (size_t at = 0; at < (size_t)got;) {
      if ((size_t)got - at < offsetof(struct p3_dirent64, name) + 1) { ok = false; break; }
      const struct p3_dirent64 *entry = (const void *)(raw.bytes + at);
      if (entry->length < offsetof(struct p3_dirent64, name) + 1 || entry->length > (size_t)got - at || entry->length % 8) { ok = false; break; }
      const char *end = memchr(entry->name, 0, entry->length - offsetof(struct p3_dirent64, name));
      if (!end) { ok = false; break; }
      size_t size = (size_t)(end - entry->name);
      if (!strcmp(entry->name, ".") || !strcmp(entry->name, "..")) { at += entry->length; continue; }
      if (!p3_name((const unsigned char *)entry->name, size) || out->count == MAX_GRAPH_NAMES) { ok = false; break; }
      for (size_t j = 0; j < out->count; j++) if (!strcmp(out->names[j], entry->name)) ok = false;
      if (!ok) break;
      memcpy(out->names[out->count], entry->name, size + 1); out->types[out->count] = entry->type; out->count++;
      if (!p3_append(c->env, out->value, p3_bytes(c, entry->name, size))) c->failed = true;
      at += entry->length;
    }
  }
#endif
  if (!ran) p3_call(c, calls, operation, false, 0, 0, true);
  snprintf(stat_name, sizeof(stat_name), "fstat-%s-after%s", resource, suffix); snprintf(fs_name, sizeof(fs_name), "fstatfs-%s-after%s", resource, suffix);
  const bool stable = p3_dir_stat(c, fd, stat_name, fs_name, calls, SYSFS_MAGIC, &after, &fs_after);
  snprintf(operation, sizeof(operation), "close-%s%s", resource, suffix); const int close_error = p3_close(c, &fd, calls, operation);
  if (ok && !eof && out->read_count >= MAX_CONTEXT_READS) c->budget_failed = true;
  out->ok = ok && eof && stable && p3_same_identity(&before, &after) && fs.f_type == fs_after.f_type && !close_error;
  return out;
}
typedef struct {
  int fd; unsigned depth;
  uint32_t major, minor;
  char relative[MAX_PATH_BYTES + 1], resolved[MAX_PATH_BYTES + 1], name[256];
  size_t resolved_size;
  struct stat st; struct statfs fs;
  napi_value binding_calls, enumeration_calls, value;
  p3_read dev, uevent, partition, loop, dm_name, dm_uuid;
  p3_names *holders, *slaves, *partitions;
  bool valid, post_valid;
} p3_node;
typedef struct { unsigned from, to; const char *kind; } p3_edge;
typedef struct {
  p3_node nodes[MAX_GRAPH_NODES]; size_t count;
  p3_edge edges[MAX_GRAPH_EDGES]; size_t edge_count;
  const char *reason; napi_value calls;
} p3_graph;
static bool p3_device_number(const p3_read *r, uint32_t *maj, uint32_t *min) {
  if (!r->ok || r->length < 4 || r->length > 22 || r->bytes[r->length - 1] != '\n') return false;
  uint64_t value[2] = {0}; unsigned part = 0; size_t digits = 0;
  for (size_t i = 0; i + 1 < r->length; i++) {
    if (r->bytes[i] == ':') { if (part || !digits) return false; part++; digits = 0; continue; }
    if (r->bytes[i] < '0' || r->bytes[i] > '9' || (digits == 1 && value[part] == 0)) return false;
    value[part] = value[part] * 10 + r->bytes[i] - '0'; digits++;
    if (value[part] > UINT32_MAX) return false;
  }
  if (part != 1 || !digits) return false;
  *maj = (uint32_t)value[0]; *min = (uint32_t)value[1]; return true;
}
static bool p3_uevent_name(const p3_read *r, const char *name) {
  if (!r->ok || !r->length || r->bytes[r->length - 1] != '\n' || memchr(r->bytes, 0, r->length)) return false;
  bool found = false;
  for (size_t at = 0; at < r->length;) {
    const unsigned char *end = memchr(r->bytes + at, '\n', r->length - at);
    if (!end) return false;
    size_t size = (size_t)(end - r->bytes) - at;
    if (size >= 8 && !memcmp(r->bytes + at, "DEVNAME=", 8)) {
      if (found || size != strlen(name) + 8 || memcmp(r->bytes + at + 8, name, size - 8)) return false;
      found = true;
    }
    at += size + 1;
  }
  return found;
}
static bool p3_absent_or_read(const p3_read *r) { return r->ok || r->open_error == ENOENT; }
static bool p3_device_link(p3_context *c, p3_node *n, unsigned index, bool after) {
  char operation[96], path[64], raw[MAX_PATH_BYTES + 1];
  snprintf(operation, sizeof(operation), "readlink-device-node-%u%s", index, after ? "-after" : "");
  snprintf(path, sizeof(path), "self/fd/%d", n->fd);
  ssize_t got = -1; int error = 0; size_t capacity = MAX_CONTEXT_BYTES - c->bytes;
  if (capacity > MAX_PATH_BYTES) capacity = MAX_PATH_BYTES;
  const bool ran = n->fd >= 0 && c->proc_fd >= 0 && p3_room(c) && capacity > 0;
  if (!capacity) c->budget_failed = true;
  if (ran) { errno = 0; got = readlinkat(c->proc_fd, path, raw, capacity); error = got < 0 ? errno : 0; }
  p3_call(c, n->binding_calls, operation, ran, got, error, true);
  if (got > 0 && !p3_account(c, (size_t)got)) return false;
  if (after && got >= 0 && n->resolved_size &&
      ((size_t)got != n->resolved_size || memcmp(n->resolved, raw, n->resolved_size))) p3_changed(c);
  if (got <= 13 || (size_t)got >= capacity || memchr(raw, 0, (size_t)got) || memcmp(raw, "/sys/devices/", 13)) return false;
  raw[got] = 0;
  const char *leaf = strrchr(raw, '/');
  if (!leaf || !p3_name((const unsigned char *)leaf + 1, strlen(leaf + 1))) return false;
  if (after) return n->resolved_size == (size_t)got && !memcmp(n->resolved, raw, (size_t)got);
  memcpy(n->resolved, raw, (size_t)got + 1); n->resolved_size = (size_t)got;
  memcpy(n->name, leaf + 1, strlen(leaf + 1) + 1); return true;
}
static int p3_add_node(p3_context *c, p3_graph *g, const char *relative, const char *expected_name, unsigned depth,
                        napi_value discovery_calls, unsigned from) {
  if (expected_name) for (size_t i = 0; i < g->count; i++) if (!strcmp(g->nodes[i].name, expected_name)) {
    struct stat actual = {0}; errno = 0;
    int rc = fstatat(c->sys_fd, relative, &actual, 0), error = rc ? errno : 0; char op[80];
    snprintf(op, sizeof(op), "stat-device-link-%u", from);
    p3_call(c, discovery_calls, op, true, rc, error, true);
    if (rc || !p3_same_identity(&g->nodes[i].st, &actual)) { g->reason = "binding"; return -1; }
    return (int)i;
  }
  if (g->count == MAX_GRAPH_NODES || depth > MAX_GRAPH_DEPTH || strlen(relative) > MAX_PATH_BYTES ||
      (!p3_room(c) && g->count)) {
    g->reason = "budget"; return -1;
  }
  const unsigned index = (unsigned)g->count++; p3_node *n = &g->nodes[index];
  n->fd = -1; n->depth = depth; n->binding_calls = p3_array(c); n->enumeration_calls = p3_array(c);
  memcpy(n->relative, relative, strlen(relative) + 1);
  char op[80], sn[80], fn[80]; snprintf(op, sizeof(op), "open-device-node-%u", index);
  n->fd = p3_open_dir(c, c->sys_fd, relative, op, n->binding_calls, true);
  snprintf(sn, sizeof(sn), "fstat-device-node-%u-before", index); snprintf(fn, sizeof(fn), "fstatfs-device-node-%u-before", index);
  bool valid = p3_dir_stat(c, n->fd, sn, fn, n->binding_calls, SYSFS_MAGIC, &n->st, &n->fs);
  bool link = p3_device_link(c, n, index, false); valid = valid && link;
  n->dev = p3_kernel_read(c, valid ? n->fd : -1, "dev", 4096, SYSFS_MAGIC);
  n->uevent = p3_kernel_read(c, valid ? n->fd : -1, "uevent", 4096, SYSFS_MAGIC);
  n->partition = p3_kernel_read(c, valid ? n->fd : -1, "partition", 4096, SYSFS_MAGIC);
  n->loop = p3_kernel_read(c, valid ? n->fd : -1, "loop/backing_file", 4096, SYSFS_MAGIC);
  n->dm_name = p3_kernel_read(c, valid ? n->fd : -1, "dm/name", 4096, SYSFS_MAGIC);
  n->dm_uuid = p3_kernel_read(c, valid ? n->fd : -1, "dm/uuid", 4096, SYSFS_MAGIC);
  valid = valid && p3_device_number(&n->dev, &n->major, &n->minor) && p3_uevent_name(&n->uevent, n->name) &&
    p3_absent_or_read(&n->partition) && p3_absent_or_read(&n->loop) && p3_absent_or_read(&n->dm_name) && p3_absent_or_read(&n->dm_uuid);
  if (expected_name && strcmp(expected_name, n->name)) valid = false;
  for (size_t i = 0; i < index; i++) if (g->nodes[i].major == n->major && g->nodes[i].minor == n->minor) valid = false;
  if (!valid && !g->reason) g->reason = c->budget_failed ? "budget" : "binding";
  n->valid = valid; return (int)index;
}
static bool p3_edge_add(p3_graph *g, unsigned from, unsigned to, const char *kind) {
  for (size_t i = 0; i < g->edge_count; i++) if (g->edges[i].from == from && g->edges[i].to == to && !strcmp(g->edges[i].kind, kind)) return true;
  if (g->edge_count == MAX_GRAPH_EDGES || from == to) { g->reason = "budget"; return false; }
  g->edges[g->edge_count++] = (p3_edge){from, to, kind}; return true;
}
static bool p3_names_contain(const p3_names *names, const char *name) {
  for (size_t i = 0; names && i < names->count; i++) if (!strcmp(names->names[i], name)) return true;
  return false;
}
static void p3_walk_graph(p3_context *c, p3_graph *g) {
  for (size_t index = 0; index < g->count && !g->reason; index++) {
    p3_node *n = &g->nodes[index]; char resource[64], relative[MAX_PATH_BYTES + 1];
    snprintf(resource, sizeof(resource), "holders-%zu", index); n->holders = p3_enumerate(c, n->fd, "holders", resource, n->enumeration_calls, false, 0);
    snprintf(resource, sizeof(resource), "slaves-%zu", index); n->slaves = p3_enumerate(c, n->fd, "slaves", resource, n->enumeration_calls, false, 0);
    snprintf(resource, sizeof(resource), "partitions-%zu", index); p3_names *parts = p3_enumerate(c, n->fd, ".", resource, n->enumeration_calls, false, 0);
    n->partitions = parts;
    if (!n->holders || !n->slaves || !parts || !n->holders->ok || !n->slaves->ok || !parts->ok) g->reason = "enumeration";
    p3_names *sets[] = {n->holders, n->slaves}; const char *kinds[] = {"holder", "slave"}, *dirs[] = {"holders", "slaves"};
    for (unsigned set = 0; set < 2 && !g->reason; set++) for (size_t j = 0; j < sets[set]->count && !g->reason; j++) {
      int length = snprintf(relative, sizeof(relative), "%s/%s/%s", n->resolved + 5, dirs[set], sets[set]->names[j]);
      if (length < 0 || (size_t)length >= sizeof(relative)) { g->reason = "budget"; break; }
      int other = p3_add_node(c, g, relative, sets[set]->names[j], n->depth + 1, n->enumeration_calls, (unsigned)index);
      if (other >= 0 && !g->reason) (void)p3_edge_add(g, (unsigned)index, (unsigned)other, kinds[set]);
    }
    for (size_t j = 0; parts && j < parts->count && !g->reason; j++) {
      if (parts->types[j] == DT_UNKNOWN) { g->reason = "enumeration"; break; }
      if (parts->types[j] != DT_DIR) continue;
      char leaf[272]; int length = snprintf(leaf, sizeof(leaf), "%s/partition", parts->names[j]);
      if (length < 0 || (size_t)length >= sizeof(leaf)) { g->reason = "budget"; break; }
      struct stat partition = {0}; errno = 0; const int rc = fstatat(n->fd, leaf, &partition, AT_SYMLINK_NOFOLLOW), error = rc ? errno : 0;
      snprintf(resource, sizeof(resource), "stat-partition-entry-%zu", index); p3_call(c, n->enumeration_calls, resource, true, rc, error, true);
      if (rc && error == ENOENT) { parts->partition_presence[j] = 1; continue; }
      if (rc || !S_ISREG(partition.st_mode)) { g->reason = "binding"; break; }
      parts->partition_presence[j] = 2; parts->partition_identity[j] = partition;
      length = snprintf(relative, sizeof(relative), "%s/%s", n->resolved + 5, parts->names[j]);
      if (length < 0 || (size_t)length >= sizeof(relative)) { g->reason = "budget"; break; }
      int child = p3_add_node(c, g, relative, parts->names[j], n->depth + 1, n->enumeration_calls, (unsigned)index);
      if (child >= 0 && !g->reason) (void)p3_edge_add(g, (unsigned)child, (unsigned)index, "parent");
    }
    if (!g->reason && n->partition.ok) {
      uint64_t number = 0;
      if (!p3_decimal_line(&n->partition, UINT32_MAX, &number) || !number) { g->reason = "format"; break; }
      memcpy(relative, n->resolved + 5, n->resolved_size - 5 + 1);
      char *slash = strrchr(relative, '/'); if (!slash) { g->reason = "binding"; break; } *slash = 0;
      const char *name = strrchr(relative, '/'); name = name ? name + 1 : relative;
      int parent = p3_add_node(c, g, relative, name, n->depth + 1, n->enumeration_calls, (unsigned)index);
      if (parent >= 0 && !g->reason) (void)p3_edge_add(g, (unsigned)index, (unsigned)parent, "parent");
    }
  }
  for (size_t i = 0; !g->reason && i < g->edge_count; i++) {
    const p3_edge *e = &g->edges[i]; p3_node *a = &g->nodes[e->from], *b = &g->nodes[e->to];
    if ((!strcmp(e->kind, "holder") && !p3_names_contain(b->slaves, a->name)) ||
        (!strcmp(e->kind, "slave") && !p3_names_contain(b->holders, a->name))) g->reason = "binding";
    if (!strcmp(e->kind, "parent") && (!a->partition.ok || strncmp(a->resolved, b->resolved, b->resolved_size) ||
        a->resolved[b->resolved_size] != '/')) g->reason = "binding";
  }
}
static bool p3_names_equal(const p3_names *a, const p3_names *b) {
  if (!a || !b || !a->ok || !b->ok || a->count != b->count) return false;
  for (size_t i = 0; i < a->count; i++) {
    bool found = false;
    for (size_t j = 0; j < b->count; j++) if (!strcmp(a->names[i], b->names[j]) && a->types[i] == b->types[j]) found = true;
    if (!found) return false;
  }
  return true;
}
static void p3_graph_after(p3_context *c, p3_graph *g) {
  c->graph_active = true;
  for (size_t i = 0; i < g->count; i++) {
    p3_node *n = &g->nodes[i]; const int base = n->valid ? n->fd : -1;
    p3_kernel_after(c, &n->dev, base, "dev", 4096, SYSFS_MAGIC);
    p3_kernel_after(c, &n->uevent, base, "uevent", 4096, SYSFS_MAGIC);
    p3_kernel_after(c, &n->partition, base, "partition", 4096, SYSFS_MAGIC);
    p3_kernel_after(c, &n->loop, base, "loop/backing_file", 4096, SYSFS_MAGIC);
    p3_kernel_after(c, &n->dm_name, base, "dm/name", 4096, SYSFS_MAGIC);
    p3_kernel_after(c, &n->dm_uuid, base, "dm/uuid", 4096, SYSFS_MAGIC);
    if ((!n->dev.ok || !n->uevent.ok || !p3_absent_or_read(&n->partition) || !p3_absent_or_read(&n->loop) ||
        !p3_absent_or_read(&n->dm_name) || !p3_absent_or_read(&n->dm_uuid)) && !g->reason) g->reason = "binding";
    p3_names *before[] = {n->holders, n->slaves, n->partitions};
    const char *labels[] = {"holders", "slaves", "partitions"}, *paths[] = {"holders", "slaves", "."};
    for (unsigned set = 0; set < 3; set++) if (before[set]) {
      char resource[64]; snprintf(resource, sizeof(resource), "%s-%zu", labels[set], i);
      p3_names *after = p3_enumerate(c, base, paths[set], resource, n->enumeration_calls, true, before[set]->read_count);
      if (!p3_names_equal(before[set], after)) {
        if (before[set]->ok && after && after->ok) p3_changed(c);
        if (!g->reason) g->reason = c->budget_failed ? "budget" : "enumeration";
      }
      free(after);
    }
    for (size_t j = 0; n->partitions && j < n->partitions->count; j++) {
      if (!n->partitions->partition_presence[j]) continue;
      char path[272], op[80]; struct stat actual = {0};
      snprintf(path, sizeof(path), "%s/partition", n->partitions->names[j]);
      snprintf(op, sizeof(op), "stat-partition-entry-%zu-after", i);
      bool ran = n->fd >= 0 && p3_room(c); int rc = -1, error = 0;
      if (ran) { errno = 0; rc = fstatat(n->fd, path, &actual, AT_SYMLINK_NOFOLLOW); error = rc ? errno : 0; }
      p3_call(c, n->enumeration_calls, op, ran, rc, error, true);
      const bool absent = ran && rc == -1 && error == ENOENT;
      const bool same = n->partitions->partition_presence[j] == 1 ? absent :
        ran && rc == 0 && p3_same_identity(&n->partitions->partition_identity[j], &actual);
      if (!same) {
        if (ran && (rc == 0 || absent)) p3_changed(c);
        if (!g->reason) g->reason = "binding";
      }
    }
    for (size_t j = 0; j < g->edge_count; j++) if (g->edges[j].from == i) {
      const p3_edge *e = &g->edges[j]; const p3_node *target = &g->nodes[e->to];
      char path[MAX_PATH_BYTES + 1], op[80]; int length = 0;
      if (!strcmp(e->kind, "parent")) {
        memcpy(path, n->resolved + 5, n->resolved_size - 5 + 1);
        char *slash = strrchr(path, '/'); if (slash) *slash = 0; else length = -1;
      } else length = snprintf(path, sizeof(path), "%s/%ss/%s", n->resolved + 5, e->kind, target->name);
      const bool ran = length >= 0 && (size_t)length < sizeof(path) && c->sys_fd >= 0 && p3_room(c);
      int rc = -1, error = 0; struct stat actual = {0};
      if (ran) { errno = 0; rc = fstatat(c->sys_fd, path, &actual, 0); error = rc ? errno : 0; }
      snprintf(op, sizeof(op), "stat-device-link-%zu-after", i); p3_call(c, n->enumeration_calls, op, ran, rc, error, true);
      if (!ran || rc || !p3_same_identity(&target->st, &actual)) {
        if (ran && !rc) p3_changed(c);
        if (!g->reason) g->reason = "binding";
      }
    }
  }
  c->graph_active = false;
}
static void p3_finish_nodes(p3_context *c, p3_graph *g) {
  c->graph_active = true;
  for (size_t i = 0; i < g->count; i++) {
    p3_node *n = &g->nodes[i]; struct stat after = {0}; struct statfs fs = {0}; char sn[80], fn[80], operation[80];
    snprintf(sn, sizeof(sn), "fstat-device-node-%zu-after", i); snprintf(fn, sizeof(fn), "fstatfs-device-node-%zu-after", i);
    bool valid = p3_dir_stat(c, n->fd, sn, fn, n->binding_calls, SYSFS_MAGIC, &after, &fs);
    bool linked = p3_device_link(c, n, (unsigned)i, true);
    snprintf(operation, sizeof(operation), "close-device-node-%zu", i); int ce = p3_close(c, &n->fd, n->binding_calls, operation);
    n->post_valid = valid && linked && p3_same_identity(&n->st, &after) && n->fs.f_type == fs.f_type && !ce;
    if (n->valid && valid && (!p3_same_identity(&n->st, &after) || n->fs.f_type != fs.f_type)) p3_changed(c);
    if (!n->post_valid && !g->reason) g->reason = "binding";
  }
  c->graph_active = false;
}
static napi_value p3_binding_value(p3_context *c, const p3_node *n) {
  napi_value value = NULL;
  if (napi_create_object(c->env, &value) != napi_ok || !set_big(c->env, value, "sourceDevMajor", n->major) ||
      !set_big(c->env, value, "sourceDevMinor", n->minor)) c->failed = true;
  (void)p3_property(c, value, "sysfs", p3_identity(c, &n->st, &n->fs));
  (void)p3_property(c, value, "kernelName", p3_bytes(c, n->name, strlen(n->name)));
  (void)p3_property(c, value, "resolved", p3_bytes(c, n->resolved, n->resolved_size));
  (void)p3_property(c, value, "sbId", p3_bytes(c, n->name, strlen(n->name)));
  return value;
}
static void p3_free_graph(p3_graph *g) {
  if (!g) return;
  for (size_t i = 0; i < g->count; i++) {
    free(g->nodes[i].holders); free(g->nodes[i].slaves); free(g->nodes[i].partitions);
  }
  free(g);
}
static napi_value p3_graph_value(p3_context *c, p3_graph *g) {
  napi_value value = NULL, nodes = p3_array(c), edges = p3_array(c), scalar;
  if (napi_create_object(c->env, &value) != napi_ok) c->failed = true;
  for (size_t i = 0; i < g->count && !g->reason; i++) {
    p3_node *n = &g->nodes[i]; napi_value row = NULL, backing = NULL;
    if (napi_create_object(c->env, &row) != napi_ok || napi_create_object(c->env, &backing) != napi_ok ||
        napi_create_uint32(c->env, (uint32_t)i, &scalar) != napi_ok || !p3_property(c, row, "index", scalar) ||
        !set_big(c->env, row, "major", n->major) || !set_big(c->env, row, "minor", n->minor)) c->failed = true;
    (void)p3_property(c, row, "identity", p3_identity(c, &n->st, &n->fs));
    (void)p3_property(c, row, "kernelName", p3_bytes(c, n->name, strlen(n->name)));
    (void)p3_property(c, row, "resolved", p3_bytes(c, n->resolved, n->resolved_size));
    (void)p3_property(c, row, "dev", n->dev.result); (void)p3_property(c, row, "uevent", n->uevent.result);
    (void)p3_property(c, row, "partition", n->partition.result);
    (void)p3_property(c, backing, "loopBackingFile", n->loop.result); (void)p3_property(c, backing, "dmName", n->dm_name.result);
    (void)p3_property(c, backing, "dmUuid", n->dm_uuid.result); (void)p3_property(c, row, "backing", backing);
    (void)p3_property(c, row, "holders", n->holders->value); (void)p3_property(c, row, "slaves", n->slaves->value);
    (void)p3_property(c, row, "enumerationCalls", n->enumeration_calls);
    if (!p3_append(c->env, nodes, row)) c->failed = true;
  }
  for (size_t i = 0; i < g->edge_count && !g->reason; i++) {
    p3_edge *e = &g->edges[i]; napi_value row = NULL;
    if (napi_create_object(c->env, &row) != napi_ok || !set_text(c->env, row, "kind", e->kind) ||
        napi_create_uint32(c->env, e->from, &scalar) != napi_ok || !p3_property(c, row, "from", scalar) ||
        napi_create_uint32(c->env, e->to, &scalar) != napi_ok || !p3_property(c, row, "to", scalar) ||
        !p3_append(c->env, edges, row)) c->failed = true;
  }
  (void)p3_property(c, value, "nodes", nodes); (void)p3_property(c, value, "edges", edges);
  return value;
}

typedef struct {
  int fd, base; long magic; const char *label;
  char path[512]; struct stat st; struct statfs fs;
  napi_value calls; bool valid, post_valid;
} p3_directory;
static p3_directory p3_directory_before(p3_context *c, int base, const char *path,
                                        const char *label, long magic) {
  p3_directory out = { .fd = -1, .base = base, .magic = magic, .label = label, .calls = p3_array(c) };
  char op[80], sn[80], fn[80];
  if (strlen(path) >= sizeof(out.path)) { c->budget_failed = true; out.base = -1; }
  else memcpy(out.path, path, strlen(path) + 1);
  snprintf(op, sizeof(op), "open-%s", label);
  out.fd = p3_open_dir(c, out.base, out.path, op, out.calls, false);
  snprintf(sn, sizeof(sn), "fstat-%s-before", label); snprintf(fn, sizeof(fn), "fstatfs-%s-before", label);
  out.valid = p3_dir_stat(c, out.fd, sn, fn, out.calls, magic, &out.st, &out.fs);
  return out;
}
static void p3_directory_after(p3_context *c, p3_directory *d) {
  char sn[80], fn[80], op[80]; struct stat after = {0}, link = {0}; struct statfs fs = {0};
  snprintf(sn, sizeof(sn), "fstat-%s-after", d->label); snprintf(fn, sizeof(fn), "fstatfs-%s-after", d->label);
  const bool valid = p3_dir_stat(c, d->fd, sn, fn, d->calls, d->magic, &after, &fs);
  int rc = -1, error = 0; const bool ran = d->valid && d->base >= 0;
  if (ran) { errno = 0; rc = fstatat(d->base, d->path, &link, AT_SYMLINK_NOFOLLOW); error = rc ? errno : 0; }
  snprintf(op, sizeof(op), "stat-%s-link-after", d->label); p3_call(c, d->calls, op, ran, rc, error, true);
  const bool same = valid && p3_same_identity(&d->st, &after) && d->fs.f_type == fs.f_type &&
    ran && !rc && p3_same_identity(&d->st, &link);
  if (d->valid && ((valid && (!p3_same_identity(&d->st, &after) || d->fs.f_type != fs.f_type)) ||
      (ran && !rc && !p3_same_identity(&d->st, &link)))) p3_changed(c);
  snprintf(op, sizeof(op), "close-%s", d->label); const int ce = p3_close(c, &d->fd, d->calls, op);
  d->post_valid = d->valid && same && !ce;
}
static bool p3_source_metadata(p3_context *c, int fd, bool directory, bool after, bool carrier,
                                napi_value calls, struct stat *st, struct statfs *fs, int *first_error) {
  int sr, se, fr, fe;
  if (after) {
    errno = 0; fr = fstatfs(fd, fs); fe = fr ? errno : 0;
    p3_call(c, calls, carrier ? "carrier-fstatfs-after" : "fstatfs-after", true, fr, fe, false);
    errno = 0; sr = fstat(fd, st); se = sr ? errno : 0;
    p3_call(c, calls, carrier ? "carrier-fstat-after" : "fstat-after", true, sr, se, false);
    if (!*first_error) *first_error = fe ? fe : se;
  } else {
    errno = 0; sr = fstat(fd, st); se = sr ? errno : 0;
    p3_call(c, calls, carrier ? "carrier-fstat-before" : "fstat-before", true, sr, se, false);
    errno = 0; fr = fstatfs(fd, fs); fe = fr ? errno : 0;
    p3_call(c, calls, carrier ? "carrier-fstatfs-before" : "fstatfs-before", true, fr, fe, false);
    if (!*first_error) *first_error = se ? se : fe;
  }
  if (sr || fr) return false;
  if (!valid_metadata(st, directory)) { p3_changed(c); return false; }
  return true;
}
static void p3_read_reject(p3_context *c, p3_read *read, const char *reason) {
  if (!read->reason) read->reason = reason;
  read->ok = false; read->result = p3_fact(c, read->calls, NULL, read->reason);
}
static void p3_block_format(p3_context *c, p3_read *read, p3_reader reader) {
  if (!read->ok) return;
  uint64_t ignored = 0;
  const bool valid = reader == P3_M04_RO ? read->length == 2 && read->bytes[1] == '\n' &&
    (read->bytes[0] == '0' || read->bytes[0] == '1') : p3_decimal_line(read, UINT64_MAX, &ignored);
  if (!valid) p3_read_reject(c, read, "format");
}
static void p3_mountinfo_limit(p3_context *c, p3_read *read) {
  if (!read->ok) return;
  size_t lines = 0, length = 0;
  for (size_t i = 0; i < read->length; i++) {
    if (read->bytes[i] == '\n') { lines++; length = 0; } else length++;
    if (lines > 4096 || length > 16384) { p3_read_reject(c, read, "budget"); return; }
  }
  if (length) p3_read_reject(c, read, "format");
}
static napi_value p3_environment_failure(p3_context *c, napi_value owner, const char *code,
                                         const char *stage, int error_number) {
  c->owner->invalid = true;
  napi_value message, error, field;
  if (napi_create_string_utf8(c->env, "Source environment observation failed", NAPI_AUTO_LENGTH, &message) != napi_ok ||
      napi_create_error(c->env, NULL, message, &error) != napi_ok ||
      !set_text(c->env, error, "code", code) || !set_text(c->env, error, "syscall", stage) ||
      napi_create_int32(c->env, error_number, &field) != napi_ok || napi_set_named_property(c->env, error, "errno", field) != napi_ok ||
      napi_create_int32(c->env, -1, &field) != napi_ok || napi_set_named_property(c->env, error, "rc", field) != napi_ok ||
      napi_set_named_property(c->env, error, "cleanupCalls", c->auxiliary) != napi_ok ||
      napi_set_named_property(c->env, error, "nativeCleanupOwner", owner) != napi_ok)
    return throw_code(c->env, code, "Could not encode environment failure");
  /* The already-delivered root remains its caller's responsibility. New aux
   * owners have all been attempted; unknown integers are never closed again. */
  (void)napi_throw(c->env, error); return NULL;
}
static napi_value p3_object(p3_context *c) {
  napi_value value = NULL;
  if (napi_create_object(c->env, &value) != napi_ok) c->failed = true;
  return value;
}
static napi_value observe_environment(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !live_owner(env, args[0], &owner) || !owner->root)
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected live native root environment owner");
  p3_context c = { .env = env, .owner = owner, .proc_fd = -1, .sys_fd = -1, .proc_owned = -1, .sys_owned = -1 };
  c.auxiliary = p3_array(&c); c.proc_calls = p3_array(&c); c.sys_calls = p3_array(&c);
  napi_value metadata_calls = p3_array(&c), carrier_calls = p3_array(&c);
  struct stat before = {0}, after = {0}, carrier_before = {0}, carrier_after = {0};
  struct statfs fs_before = {0}, fs_after = {0}, carrier_fs = {0}, carrier_fs_after = {0};
  int metadata_error = 0; const int carrier = owner->metadata_only ? owner->parent_fd : owner->fd;
  const bool carrier_directory = owner->metadata_only || owner->directory;
  const bool source_ok = p3_source_metadata(&c, owner->fd, owner->directory, false, false,
    metadata_calls, &before, &fs_before, &metadata_error);
  const bool carrier_ok = p3_source_metadata(&c, carrier, carrier_directory, false, true,
    carrier_calls, &carrier_before, &carrier_fs, &metadata_error);
  if (!source_ok || !carrier_ok || !same_metadata(&owner->initial, &before) || before.st_dev != carrier_before.st_dev ||
      fs_before.f_type != carrier_fs.f_type ||
      (owner->metadata_only && !same_metadata(&owner->parent_initial, &carrier_before)))
    return p3_environment_failure(&c, args[0], metadata_error ? "ERR_SOURCE_NATIVE_IO" : "ERR_SOURCE_IDENTITY",
      "environment-source-before", metadata_error ? metadata_error : ESTALE);
  uint64_t carrier_legacy_before = 0, carrier_unique_before = 0, carrier_legacy_after = 0, carrier_unique_after = 0;
  if (owner->tail && (!mount_pair(carrier, &carrier_before, &carrier_legacy_before, &carrier_unique_before) ||
      carrier_legacy_before != owner->legacy_mount_id || carrier_unique_before != owner->unique_mount_id))
    return p3_environment_failure(&c, args[0], "ERR_SOURCE_IDENTITY", "tail-carrier-mount-before", ESTALE);

  c.proc_fd = p3_anchor(&c, "/proc", "proc-root", PROC_SUPER_MAGIC, c.proc_calls, &c.proc_owned);
  c.sys_fd = p3_anchor(&c, "/sys", "sysfs-root", SYSFS_MAGIC, c.sys_calls, &c.sys_owned);
  p3_credentials credentials = {0}; p3_read thread_status, process_stat;
  p3_identity_before(&c, &credentials, &thread_status, &process_stat);
  p3_namespaces namespace_before = {0}, namespace_after = {0}; napi_value namespace_calls = p3_array(&c);
  napi_value namespace_value = p3_namespace_pass(&c, credentials.pid, credentials.tid, false, &namespace_before, namespace_calls);
  napi_value uname_value = p3_uname_fact(&c);
  p3_read notes = p3_kernel_read(&c, c.sys_fd, "kernel/notes", 1048576, SYSFS_MAGIC);
  napi_value config_value = p3_missing(&c, "read-kernel-config", "unsupported");
  struct statx legacy_raw, unique_raw, legacy_after_raw, unique_after_raw;
  bool legacy_available, unique_available, legacy_after_available, unique_after_available;
  p3_sample legacy = p3_statx_fact(&c, owner->fd, &before, false, &legacy_raw, &legacy_available, false);
  p3_sample unique = p3_statx_fact(&c, owner->fd, &before, true, &unique_raw, &unique_available, false);
  p3_sample mount = p3_statmount_fact(&c, &unique_raw, unique_available, false);
  char path[512]; snprintf(path, sizeof(path), "%d/task/%d/mountinfo", credentials.pid, credentials.tid);
  p3_read mountinfo = p3_kernel_read(&c, credentials.pid > 0 && credentials.tid > 0 ? c.proc_fd : -1,
    path, 1048576, PROC_SUPER_MAGIC); p3_mountinfo_limit(&c, &mountinfo);
  const bool ext4 = (long)fs_before.f_type == EXT4_SUPER_MAGIC && (long)carrier_fs.f_type == EXT4_SUPER_MAGIC;
  p3_sample tune = p3_tune_fact(&c, ext4 ? carrier : -1, false);

  p3_graph *graph = calloc(1, sizeof(*graph)); p3_node *device_node = NULL;
  c.graph_calls = p3_array(&c);
  if (!graph) c.failed = true;
  else {
    graph->calls = c.graph_calls; c.graph_active = true;
    snprintf(path, sizeof(path), "dev/block/%u:%u", major(before.st_dev), minor(before.st_dev));
    const int index = p3_add_node(&c, graph, path, NULL, 0, graph->calls, 0);
    if (index >= 0) {
      device_node = &graph->nodes[index];
      if (device_node->valid && (device_node->major != major(before.st_dev) || device_node->minor != minor(before.st_dev))) {
        device_node->valid = false; graph->reason = "binding";
      }
    }
    if (device_node && device_node->valid) p3_walk_graph(&c, graph);
    else p3_call(&c, graph->calls, "enumerate-device-graph", false, 0, 0, true);
    c.graph_active = false;
  }
  const bool device_bound = graph && device_node == &graph->nodes[0] && device_node->valid;
  const int block_base = device_bound ? device_node->fd : -1;
  p3_read block_size = p3_block_before(&c, block_base, P3_M04_SIZE);
  p3_read block_ro = p3_block_before(&c, block_base, P3_M04_RO);
  p3_read block_diskseq = p3_block_before(&c, block_base, P3_M04_DISKSEQ);
  snprintf(path, sizeof(path), "fs/ext4/%s", device_bound ? device_node->name : "");
  p3_directory health_dir = p3_directory_before(&c, device_bound && ext4 ? c.sys_fd : -1,
    path, "health-directory", SYSFS_MAGIC);
  p3_directory ext4_proc = p3_directory_before(&c, device_bound && ext4 ? c.proc_fd : -1,
    path, "ext4-proc-directory", PROC_SUPER_MAGIC);
  const int health_fd = health_dir.valid ? health_dir.fd : -1, proc_fd = ext4_proc.valid ? ext4_proc.fd : -1;
  p3_read options = p3_kernel_read(&c, proc_fd, "options", 16384, PROC_SUPER_MAGIC);
  p3_read mb_groups = p3_kernel_read(&c, proc_fd, "mb_groups", 16384, PROC_SUPER_MAGIC);
  p3_read mb_structs_summary = p3_kernel_read(&c, proc_fd, "mb_structs_summary", 16384, PROC_SUPER_MAGIC);
  p3_read journal_before = p3_kernel_read(&c, health_fd, "journal_task", 4096, SYSFS_MAGIC);
  p3_sample ioprio = p3_ioprio_fact(&c, &journal_before, false);
  static const char *health_names[] = {"errors_count", "first_error_errcode", "last_error_errcode", "first_error_ino",
    "last_error_ino", "first_error_block", "last_error_block", "first_error_line", "last_error_line", "first_error_time",
    "last_error_time", "first_error_func", "last_error_func"};
  p3_read health_reads[13];
  for (unsigned i = 0; i < 13; i++) health_reads[i] = p3_kernel_read(&c, health_fd, health_names[i], 4096, SYSFS_MAGIC);

  /* These are actual post-health operations, not a second label on the first
   * sample. Each repeated item retains the original finite read allowance. */
  p3_read journal_after = p3_kernel_read(&c, health_fd, "journal_task", 4096, SYSFS_MAGIC);
  p3_sample ioprio_after = p3_ioprio_fact(&c, &journal_after, true);
  napi_value ioprio_value = p3_sample_join(&c, &ioprio, &ioprio_after);
  if (journal_before.ok && journal_after.ok && (journal_before.length != journal_after.length ||
      (journal_before.length && memcmp(journal_before.bytes, journal_after.bytes, journal_before.length)))) p3_changed(&c);
  p3_sample tune_after = p3_tune_fact(&c, ext4 ? carrier : -1, true);
  napi_value tune_value = p3_sample_join(&c, &tune, &tune_after);
  p3_kernel_after(&c, &options, proc_fd, "options", 16384, PROC_SUPER_MAGIC);
  p3_kernel_after(&c, &mb_groups, proc_fd, "mb_groups", 16384, PROC_SUPER_MAGIC);
  p3_mb_summary_after(&c, &mb_structs_summary, proc_fd);
  p3_sample legacy_after = p3_statx_fact(&c, owner->fd, &before, false, &legacy_after_raw, &legacy_after_available, true);
  p3_sample unique_after = p3_statx_fact(&c, owner->fd, &before, true, &unique_after_raw, &unique_after_available, true);
  p3_sample mount_after = p3_statmount_fact(&c, &unique_after_raw, unique_after_available, true);
  napi_value legacy_value = p3_sample_join(&c, &legacy, &legacy_after);
  napi_value unique_value = p3_sample_join(&c, &unique, &unique_after);
  napi_value mount_value = p3_sample_join(&c, &mount, &mount_after);
  p3_block_after(&c, &block_size, block_base, P3_M04_SIZE);
  p3_block_after(&c, &block_ro, block_base, P3_M04_RO);
  p3_block_after(&c, &block_diskseq, block_base, P3_M04_DISKSEQ);
  /* Compare the successful raw endpoints before classifying stable invalid
   * text. Otherwise two different invalid strings could hide a change. */
  p3_block_format(&c, &block_size, P3_M04_SIZE);
  p3_block_format(&c, &block_ro, P3_M04_RO);
  p3_block_format(&c, &block_diskseq, P3_M04_DISKSEQ);
  if (graph) { p3_graph_after(&c, graph); p3_finish_nodes(&c, graph); }
  p3_directory_after(&c, &health_dir); p3_directory_after(&c, &ext4_proc);
  if (!ext4_proc.post_valid) {
    p3_read_reject(&c, &options, "binding"); p3_read_reject(&c, &mb_groups, "binding");
    p3_read_reject(&c, &mb_structs_summary, "binding");
  }
  if (!health_dir.post_valid) {
    p3_read_reject(&c, &journal_before, "binding"); p3_read_reject(&c, &journal_after, "binding");
    for (unsigned i = 0; i < 13; i++) p3_read_reject(&c, &health_reads[i], "binding");
    ioprio_value = p3_fact(&c, ioprio.calls, NULL, ioprio.reason ? ioprio.reason : "binding");
  }
  (void)p3_namespace_pass(&c, credentials.pid, credentials.tid, true, &namespace_after, namespace_calls);
  bool namespaces_stable = namespace_before.ok && namespace_after.ok;
  for (unsigned i = 0; namespaces_stable && i < 3; i++)
    if (!p3_same_identity(&namespace_before.st[i], &namespace_after.st[i]) || namespace_before.fs[i].f_type != namespace_after.fs[i].f_type ||
        namespace_before.size[i] != namespace_after.size[i] || memcmp(namespace_before.raw[i], namespace_after.raw[i], namespace_before.size[i])) {
      namespaces_stable = false; p3_changed(&c);
    }
  napi_value namespaces_value = p3_fact(&c, namespace_calls, namespaces_stable ? namespace_value : NULL, namespaces_stable ? NULL : "binding");
  napi_value identity_value = p3_identity_after(&c, &credentials);
  (void)p3_close(&c, &c.sys_owned, c.sys_calls, "close-sysfs-root"); c.sys_fd = -1;
  (void)p3_close(&c, &c.proc_owned, c.proc_calls, "close-proc-root"); c.proc_fd = -1;
  const bool source_after_ok = p3_source_metadata(&c, owner->fd, owner->directory, true, false,
    metadata_calls, &after, &fs_after, &metadata_error);
  const bool carrier_after_ok = p3_source_metadata(&c, carrier, carrier_directory, true, true,
    carrier_calls, &carrier_after, &carrier_fs_after, &metadata_error);
  if (owner->tail && (!carrier_after_ok || !mount_pair(carrier, &carrier_after, &carrier_legacy_after, &carrier_unique_after) ||
      carrier_legacy_before != carrier_legacy_after || carrier_unique_before != carrier_unique_after)) p3_changed(&c);
  if (source_after_ok && carrier_after_ok && (!same_metadata(&before, &after) || fs_before.f_type != fs_after.f_type ||
      !same_metadata(&carrier_before, &carrier_after) || carrier_fs.f_type != carrier_fs_after.f_type)) p3_changed(&c);
  if (c.changed || c.close_failed_at || !source_after_ok || !carrier_after_ok || c.failed) {
    p3_free_graph(graph);
    const bool first_change = c.changed && (!c.close_failed_at || c.changed_at < c.close_failed_at);
    return p3_environment_failure(&c, args[0], first_change ? "ERR_SOURCE_IDENTITY" :
      c.close_failed_at || metadata_error ? "ERR_SOURCE_NATIVE_IO" : "ERR_SOURCE_RESULT",
      first_change ? "environment-changed" : c.close_failed_at ? "environment-close" : "environment-result",
      first_change ? ESTALE : c.close_error ? c.close_error : metadata_error ? metadata_error : EIO);
  }

  napi_value result = p3_object(&c), source = p3_object(&c), filesystem_carrier = p3_object(&c),
    process = p3_object(&c), kernel = p3_object(&c), mount_group = p3_object(&c), configuration = p3_object(&c),
    device = p3_object(&c), block_attributes = p3_object(&c), health = p3_object(&c), health_fields = p3_array(&c), version;
  if (napi_create_uint32(env, owner->tail ? 3 : 2, &version) != napi_ok || !p3_property(&c, result, "abiVersion", version) ||
      !set_text(env, result, "rootKind", owner->directory ? "directory" : "file") ||
      !set_text(env, result, "rootStage", owner->metadata_only ? "metadata-only" : "readable")) c.failed = true;
  (void)p3_property(&c, source, "before", extended_metadata(env, &before, &fs_before, owner->directory));
  (void)p3_property(&c, source, "after", extended_metadata(env, &after, &fs_after, owner->directory));
  (void)p3_property(&c, source, "metadataCalls", metadata_calls); (void)p3_property(&c, source, "carrierCalls", carrier_calls);
  if (!set_text(env, filesystem_carrier, "role", owner->tail ? "tail-carrier" : owner->metadata_only ? "bootstrap-parent" : "root")) c.failed = true;
  (void)p3_property(&c, filesystem_carrier, "before", extended_metadata(env, &carrier_before, &carrier_fs, carrier_directory));
  (void)p3_property(&c, filesystem_carrier, "after", extended_metadata(env, &carrier_after, &carrier_fs_after, carrier_directory));
  if (owner->tail) {
    napi_value binding = p3_object(&c), first = p3_object(&c), last = p3_object(&c);
    if (!set_big(env, first, "legacyMountId", carrier_legacy_before) || !set_big(env, first, "uniqueMountId", carrier_unique_before) ||
        !set_big(env, last, "legacyMountId", carrier_legacy_after) || !set_big(env, last, "uniqueMountId", carrier_unique_after)) c.failed = true;
    (void)p3_property(&c, binding, "before", first); (void)p3_property(&c, binding, "after", last);
    (void)p3_property(&c, filesystem_carrier, "mount", binding);
  }
  (void)p3_property(&c, source, "filesystemCarrier", filesystem_carrier);
  (void)p3_property(&c, process, "identity", identity_value); (void)p3_property(&c, process, "threadStatus", thread_status.result);
  (void)p3_property(&c, process, "processStat", process_stat.result); (void)p3_property(&c, process, "namespaces", namespaces_value);
  (void)p3_property(&c, kernel, "uname", uname_value); (void)p3_property(&c, kernel, "notes", notes.result);
  (void)p3_property(&c, kernel, "config", config_value);
  (void)p3_property(&c, mount_group, "legacyStatx", legacy_value); (void)p3_property(&c, mount_group, "uniqueStatx", unique_value);
  (void)p3_property(&c, mount_group, "statmount", mount_value); (void)p3_property(&c, mount_group, "mountinfo", mountinfo.result);
  (void)p3_property(&c, configuration, "tune", tune_value); (void)p3_property(&c, configuration, "options", options.result);
  (void)p3_property(&c, configuration, "mbGroups", mb_groups.result); (void)p3_property(&c, configuration, "journalTaskBefore", journal_before.result);
  (void)p3_property(&c, configuration, "mbStructsSummary", mb_structs_summary.result);
  (void)p3_property(&c, configuration, "journalTaskAfter", journal_after.result); (void)p3_property(&c, configuration, "journalIoprio", ioprio_value);
  const bool device_stable = device_bound && device_node->post_valid;
  if (!device_stable) {
    p3_read_reject(&c, &block_size, "binding"); p3_read_reject(&c, &block_ro, "binding");
    p3_read_reject(&c, &block_diskseq, "binding");
  }
  napi_value reader_revision = NULL, source_node_index = NULL;
  if (napi_create_uint32(env, 1, &reader_revision) != napi_ok || napi_create_uint32(env, 0, &source_node_index) != napi_ok) c.failed = true;
  (void)p3_property(&c, block_attributes, "readerRevision", reader_revision);
  (void)p3_property(&c, block_attributes, "sourceNodeIndex", source_node_index);
  (void)p3_property(&c, block_attributes, "size", block_size.result);
  (void)p3_property(&c, block_attributes, "readOnly", block_ro.result);
  (void)p3_property(&c, block_attributes, "diskSequence", block_diskseq.result);
  (void)p3_property(&c, device, "blockAttributes", block_attributes);
  napi_value device_binding = p3_fact(&c, device_node->binding_calls,
    device_stable ? p3_binding_value(&c, device_node) : NULL, device_stable ? NULL : "binding");
  (void)p3_property(&c, device, "binding", device_binding); (void)p3_property(&c, device, "dev", device_node->dev.result);
  (void)p3_property(&c, device, "uevent", device_node->uevent.result);
  (void)p3_property(&c, device, "topology", p3_fact(&c, graph->calls,
    graph->reason ? NULL : p3_graph_value(&c, graph), graph->reason));
  napi_value health_binding = NULL;
  if (device_stable && health_dir.post_valid) {
    health_binding = p3_object(&c);
    if (!set_big(env, health_binding, "sourceDevMajor", device_node->major) ||
        !set_big(env, health_binding, "sourceDevMinor", device_node->minor)) c.failed = true;
    (void)p3_property(&c, health_binding, "device", p3_identity(&c, &device_node->st, &device_node->fs));
    (void)p3_property(&c, health_binding, "health", p3_identity(&c, &health_dir.st, &health_dir.fs));
    (void)p3_property(&c, health_binding, "sbId", p3_bytes(&c, device_node->name, strlen(device_node->name)));
  }
  (void)p3_property(&c, health, "binding", p3_fact(&c, health_dir.calls, health_binding, health_binding ? NULL : "binding"));
  for (unsigned i = 0; i < 13; i++) {
    napi_value field = p3_object(&c); if (!set_text(env, field, "name", health_names[i])) c.failed = true;
    (void)p3_property(&c, field, "fact", health_reads[i].result); if (!p3_append(env, health_fields, field)) c.failed = true;
  }
  (void)p3_property(&c, health, "fields", health_fields);
  (void)p3_property(&c, result, "source", source); (void)p3_property(&c, result, "process", process);
  (void)p3_property(&c, result, "kernel", kernel); (void)p3_property(&c, result, "mount", mount_group);
  (void)p3_property(&c, result, "configuration", configuration); (void)p3_property(&c, result, "device", device);
  (void)p3_property(&c, result, "health", health); (void)p3_property(&c, result, "auxiliaryCalls", c.auxiliary);
  p3_free_graph(graph);
  if (c.failed) return p3_environment_failure(&c, args[0], "ERR_SOURCE_RESULT", "environment-encode", EIO);
  return result;
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
static bool valid_utf8(const unsigned char *s, size_t n) {
  for (size_t i = 0; i < n;) {
    unsigned char c = s[i++];
    if (c < 0x80) continue;
    size_t more; unsigned char low = 0x80, high = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) more = 1;
    else if (c >= 0xe0 && c <= 0xef) { more = 2; if (c == 0xe0) low = 0xa0; if (c == 0xed) high = 0x9f; }
    else if (c >= 0xf0 && c <= 0xf4) { more = 3; if (c == 0xf0) low = 0x90; if (c == 0xf4) high = 0x8f; }
    else return false;
    if (more > n - i || s[i] < low || s[i] > high) return false;
    i++;
    for (size_t j = 1; j < more; j++, i++) if (s[i] < 0x80 || s[i] > 0xbf) return false;
  }
  return true;
}
static napi_value read_directory(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !get_owner(env, args[0], &owner) || !owner->directory)
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected live source directory");
  if (!valid_opened(owner->fd, true)) return throw_code(env, "ERR_SOURCE_IDENTITY", "Source directory changed");
  p3_context c = { .env = env, .owner = owner }; c.auxiliary = p3_array(&c);
  errno = 0; int clone = fcntl(owner->fd, F_DUPFD_CLOEXEC, 0), duplicate_error = clone < 0 ? errno : 0;
  p3_call(&c, c.auxiliary, "duplicate-source-dir", true, clone, duplicate_error, false);
  if (clone < 0) { errno = duplicate_error; return os_error(env, "duplicate-source-dir"); }
  DIR *stream = fdopendir(clone);
  if (!stream) {
    const int first_error = errno;
    (void)p3_close(&c, &clone, c.auxiliary, "close-directory-duplicate");
    return p3_environment_failure(&c, args[0], "ERR_SOURCE_NATIVE_IO", "fdopendir-source", first_error);
  }
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
      const size_t bytes = strnlen(entry->d_name, sizeof(entry->d_name));
      if (bytes == sizeof(entry->d_name) || !valid_utf8((const unsigned char *)entry->d_name, bytes)) { seen_error = EILSEQ; break; }
      napi_value name;
      char roundtrip[sizeof(entry->d_name)]; size_t copied = 0;
      if (napi_create_string_utf8(env, entry->d_name, bytes, &name) != napi_ok ||
          napi_get_value_string_utf8(env, name, roundtrip, sizeof(roundtrip), &copied) != napi_ok ||
          copied != bytes || memcmp(roundtrip, entry->d_name, bytes) != 0 ||
          napi_set_element(env, array, length++, name) != napi_ok) { seen_error = EINVAL; break; }
      errno = 0;
    }
  }
  errno = 0; const int close_rc = closedir(stream), close_error = close_rc ? errno : 0;
  p3_call(&c, c.auxiliary, "closedir-source", true, close_rc, close_error, false);
  if (close_rc) {
    owner->invalid = true;
    if (owner->unresolved_aux_count < sizeof(owner->unresolved_aux) / sizeof(owner->unresolved_aux[0]))
      owner->unresolved_aux[owner->unresolved_aux_count++] = clone;
    else c.failed = true;
  }
  if (close_rc || seen_error || !ok || c.failed || !valid_opened(owner->fd, true))
    return p3_environment_failure(&c, args[0], "ERR_SOURCE_DIRECTORY", "read-directory",
      seen_error ? seen_error : close_error ? close_error : !ok || c.failed ? EIO : ESTALE);
  return array;
}
static napi_value close_owner(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !lookup_owner(env, args[0], &owner))
    return throw_code(env, "ERR_SOURCE_HANDLE", "Source handle already closed or unknown");
  if (owner->busy) return throw_code(env, "ERR_SOURCE_BUSY", "Source operation has not settled");
  if (owner->fd < 0 && owner->parent_fd < 0)
    return throw_code(env, "ERR_SOURCE_HANDLE", "Source handle already closed or unknown");
  napi_value calls;
  if (napi_create_array(env, &calls) != napi_ok) return NULL;
  const int error = close_resources(env, owner, calls);
  if (error) return owner_error_calls(env, args[0], owner, "ERR_SOURCE_NATIVE_IO", "close-source", error, calls);
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}

/* CFP2: only these fixed operations run on the Node worker pool. The strong
 * reference owns the actual wrapped descriptor through completion; busy is
 * changed only on the JS thread, and all other entrypoints reject it before
 * touching fields the worker may change. No cancellation or GC is completion. */
typedef struct {
  source_owner *owner;
  napi_ref reference;
  napi_async_work work;
  napi_deferred deferred;
  bool closing;
  bool source_ran, parent_ran;
  int source_rc, source_error, parent_rc, parent_error, error;
} source_work;

static void worker_close_slot(int *fd, bool *unknown, int *saved,
                              bool *ran, int *rc, int *error) {
  if (*fd < 0 || *unknown) { *error = *saved; return; }
  *unknown = true; *ran = true;
  errno = 0; *rc = close(*fd); *error = *rc ? errno : 0;
  if (!*rc) { *fd = -1; *unknown = false; }
  else *saved = *error;
}
static void source_work_execute(napi_env env, void *data) {
  (void)env; source_work *work = data; source_owner *owner = work->owner;
  if (!work->closing) {
    work->source_ran = true; errno = 0;
    work->source_rc = fsync(owner->fd);
    work->error = work->source_error = work->source_rc ? errno : 0;
    return;
  }
  /* Keep this owner's namespace carrier until its source release has ended. */
  owner->close_started = true;
  if (owner->tail) worker_close_slot(&owner->parent_fd, &owner->parent_close_unknown, &owner->parent_close_error,
    &work->parent_ran, &work->parent_rc, &work->parent_error);
  worker_close_slot(&owner->fd, &owner->close_unknown, &owner->close_error,
    &work->source_ran, &work->source_rc, &work->source_error);
  if (!owner->tail) worker_close_slot(&owner->parent_fd, &owner->parent_close_unknown, &owner->parent_close_error,
    &work->parent_ran, &work->parent_rc, &work->parent_error);
  work->error = owner->tail && work->parent_error ? work->parent_error : work->source_error ? work->source_error : work->parent_error ? work->parent_error :
    owner->unresolved_aux_count ? EIO : 0;
}
static napi_value source_work_error(napi_env env, napi_value handle, source_work *work, const char *stage) {
  napi_value result, calls, field, message;
  work->owner->invalid = true;
  if (napi_create_string_utf8(env, "Source-file native operation failed", NAPI_AUTO_LENGTH, &message) == napi_ok &&
        napi_create_error(env, NULL, message, &result) == napi_ok &&
        napi_create_array(env, &calls) == napi_ok) {
      if (work->closing && work->owner->tail) (void)append_call(env, calls, "close-tail-carrier", work->parent_ran,
        work->parent_rc, work->parent_error);
      (void)append_call(env, calls, work->closing ? work->owner->tail ? "close-tail-metadata" : "close-source" : "fsync-source", work->source_ran,
        work->source_rc, work->source_error);
      if (work->closing && !work->owner->tail) (void)append_call(env, calls, "close-bootstrap-parent", work->parent_ran,
        work->parent_rc, work->parent_error);
      if (napi_create_string_utf8(env, "ERR_SOURCE_NATIVE_IO", NAPI_AUTO_LENGTH, &field) == napi_ok)
        (void)napi_set_named_property(env, result, "code", field);
      if (napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &field) == napi_ok)
        (void)napi_set_named_property(env, result, "syscall", field);
      if (napi_create_int32(env, work->error, &field) == napi_ok) (void)napi_set_named_property(env, result, "errno", field);
      if (napi_create_int32(env, -1, &field) == napi_ok) (void)napi_set_named_property(env, result, "rc", field);
      (void)napi_set_named_property(env, result, "cleanupCalls", calls);
      (void)napi_set_named_property(env, result, "nativeCleanupOwner", handle);
      return result;
  }
  return NULL;
}
static void source_work_complete(napi_env env, napi_status status, void *data) {
  source_work *work = data; napi_value result, handle;
  work->owner->busy = false;
  if (status != napi_ok && !work->error) work->error = EIO;
  if (!work->error) {
    if (napi_get_undefined(env, &result) == napi_ok) (void)napi_resolve_deferred(env, work->deferred, result);
  } else if (napi_get_reference_value(env, work->reference, &handle) == napi_ok &&
      (result = source_work_error(env, handle, work, work->closing ? "close-source" : "fsync-source")))
    (void)napi_reject_deferred(env, work->deferred, result);
  (void)napi_delete_reference(env, work->reference);
  (void)napi_delete_async_work(env, work->work);
  free(work);
}
static napi_value start_source_work(napi_env env, napi_callback_info info, bool closing) {
  size_t count = 1; napi_value args[1], name, promise; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !lookup_owner(env, args[0], &owner))
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected actual source owner");
  if (owner->busy) return throw_code(env, "ERR_SOURCE_BUSY", "Source operation has not settled");
  if (closing ? owner->fd < 0 && owner->parent_fd < 0 :
      owner->fd < 0 || owner->metadata_only || owner->close_unknown || owner->invalid)
    return throw_code(env, "ERR_SOURCE_HANDLE", "Source owner cannot start this operation");
  source_work *work = calloc(1, sizeof(*work));
  if (!work) {
    if (closing) owner->close_start_failed = true;
    return throw_code(env, "ERR_SOURCE_ALLOC", "Source work allocation failed");
  }
  work->owner = owner; work->closing = closing;
  if (napi_create_string_utf8(env, closing ? "source-close" : "source-fsync", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_reference(env, args[0], 1, &work->reference) != napi_ok ||
      napi_create_promise(env, &work->deferred, &promise) != napi_ok ||
      napi_create_async_work(env, NULL, name, source_work_execute, source_work_complete, work, &work->work) != napi_ok) {
    if (closing) owner->close_start_failed = true;
    if (work->reference) (void)napi_delete_reference(env, work->reference);
    free(work); return throw_code(env, "ERR_SOURCE_ALLOC", "Source work creation failed");
  }
  owner->busy = true;
  if (napi_queue_async_work(env, work->work) != napi_ok) {
    if (closing) owner->close_start_failed = true;
    owner->busy = false;
    source_work_complete(env, napi_generic_failure, work);
  }
  return promise;
}
static napi_value synchronize_owner(napi_env env, napi_callback_info info) { return start_source_work(env, info, false); }
static napi_value close_owner_async(napi_env env, napi_callback_info info) { return start_source_work(env, info, true); }
/* Allocation/creation/queue failure has not necessarily executed close. Only
 * this native owner can distinguish that fact. A failed startup may therefore
 * finish its original slots synchronously, without allocating another worker.
 * An attempted/unknown close is never repeated, and busy still means in flight.
 * true is returned only after all actual owned resources are known closed. */
static napi_value close_owner_unstarted(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1], result; source_owner *owner;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1 ||
      !lookup_owner(env, args[0], &owner))
    return throw_code(env, "ERR_SOURCE_HANDLE", "Expected actual source owner");
  if (owner->busy) return throw_code(env, "ERR_SOURCE_BUSY", "Source operation has not settled");
  if (owner->close_start_failed && !owner->close_started) {
    source_work cleanup = {0}; cleanup.owner = owner; cleanup.closing = true;
    source_work_execute(env, &cleanup);
    if (cleanup.error) {
      result = source_work_error(env, args[0], &cleanup, "close-unstarted");
      if (result) (void)napi_throw(env, result);
      return NULL;
    }
  }
  const bool closed = owner->fd < 0 && owner->parent_fd < 0 && !owner->close_unknown &&
    !owner->parent_close_unknown && owner->unresolved_aux_count == 0;
  if (napi_get_boolean(env, closed, &result) != napi_ok) return NULL;
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    { "openRoot", NULL, open_root, NULL, NULL, NULL, napi_default, NULL },
    { "rootInfo", NULL, root_info, NULL, NULL, NULL, napi_default, NULL },
    { "openRootContent", NULL, open_root_content, NULL, NULL, NULL, napi_default, NULL },
    { "openChild", NULL, open_child, NULL, NULL, NULL, napi_default, NULL },
    { "reopenFile", NULL, reopen_file, NULL, NULL, NULL, napi_default, NULL },
    { "retainMetadata", NULL, retain_metadata, NULL, NULL, NULL, napi_default, NULL },
    { "transferCarrier", NULL, transfer_carrier, NULL, NULL, NULL, napi_default, NULL },
    { "observe", NULL, observe, NULL, NULL, NULL, napi_default, NULL },
    { "observeStatx", NULL, observe_statx, NULL, NULL, NULL, napi_default, NULL },
    { "observeStatxUnique", NULL, observe_statx_unique, NULL, NULL, NULL, napi_default, NULL },
    { "observeExtended", NULL, observe_extended, NULL, NULL, NULL, napi_default, NULL },
    { "observeEnvironment", NULL, observe_environment, NULL, NULL, NULL, napi_default, NULL },
    { "readAt", NULL, read_at, NULL, NULL, NULL, napi_default, NULL },
    { "readDirectory", NULL, read_directory, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, close_owner, NULL, NULL, NULL, napi_default, NULL },
    { "synchronize", NULL, synchronize_owner, NULL, NULL, NULL, napi_default, NULL },
    { "closeAsync", NULL, close_owner_async, NULL, NULL, NULL, napi_default, NULL },
    { "closeUnstarted", NULL, close_owner_unstarted, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, sizeof(methods)/sizeof(methods[0]), methods) != napi_ok)
    return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
