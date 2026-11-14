/* #152 public restore: only private leaves relative to an already pinned directory. */
#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum action { CREATE_FILE, READ_FILE, STAT_FILE };
struct operation {
  napi_async_work work;
  napi_deferred deferred;
  enum action action;
  int directory;
  int opened;
  char leaf[128];
  uint64_t device;
  uint64_t inode;
  struct stat info;
  const char *stage;
  const char *code;
  int error;
};

static const char *error_name(int error) {
  switch (error) {
    case EACCES: return "EACCES";
    case EBADF: return "EBADF";
    case EEXIST: return "EEXIST";
    case EINVAL: return "EINVAL";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case ENODEV: return "ENODEV";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case ENXIO: return "ENXIO";
    case EPERM: return "EPERM";
    default: return "SYSTEM_ERROR";
  }
}

static void reject_operation(struct operation *op, const char *stage, const char *code, int error) {
  if (op->code == NULL) { op->stage = stage; op->code = code; op->error = error; }
}

static bool allowed_leaf(const char *leaf, size_t length) {
  static const char *suffixes[] = {
    "-archive.dump", "-complete.toc", "-namespace.list", "-body.list", "-namespace.sql", "-body.sql"
  };
  if (length < 44 || length >= 128 || memchr(leaf, '\0', length) != NULL ||
      strncmp(leaf, ".public-", 8) != 0) return false;
  for (size_t i = 0; i < 36; i++) {
    const char c = leaf[8 + i];
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (c != '-') return false;
    } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  for (size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); i++) {
    if (strcmp(leaf + 44, suffixes[i]) == 0) return true;
  }
  return false;
}

static bool check_directory(struct operation *op) {
  struct stat current;
  if (fstat(op->directory, &current) != 0) {
    const int saved = errno; reject_operation(op, "fstat-directory", error_name(saved), saved); return false;
  }
  if (!S_ISDIR(current.st_mode) || current.st_uid != getuid() || (current.st_mode & 0777) != 0700 ||
      (uint64_t)current.st_dev != op->device || (uint64_t)current.st_ino != op->inode) {
    reject_operation(op, "directory-identity", "ERR_DIRECTORY_IDENTITY", 0); return false;
  }
  return true;
}

static bool check_file(struct operation *op) {
  const struct stat *info = &op->info;
  if (!S_ISREG(info->st_mode) || info->st_nlink != 1 || info->st_uid != getuid() ||
      (info->st_mode & 0777) != 0600 || info->st_size < 0) {
    reject_operation(op, "file-identity", "ERR_FILE_IDENTITY", 0); return false;
  }
  return true;
}

static void execute(napi_env env, void *data) {
  (void)env;
  struct operation *op = data;
  if (check_directory(op)) {
    if (op->action == STAT_FILE) {
      if (fstatat(op->directory, op->leaf, &op->info, AT_SYMLINK_NOFOLLOW) != 0) {
        const int saved = errno; reject_operation(op, "fstatat", error_name(saved), saved);
      } else (void)check_file(op);
    } else {
      const int flags = O_NOFOLLOW | O_CLOEXEC |
        (op->action == CREATE_FILE ? O_CREAT | O_EXCL | O_RDWR : O_RDONLY | O_NONBLOCK);
      op->opened = openat(op->directory, op->leaf, flags, 0600);
      if (op->opened < 0) {
        const int saved = errno; reject_operation(op, "openat", error_name(saved), saved);
      } else if (fstat(op->opened, &op->info) != 0) {
        const int saved = errno; reject_operation(op, "fstat-file", error_name(saved), saved);
      } else (void)check_file(op);
    }
    if (op->code == NULL) (void)check_directory(op);
  }
  const int directory = op->directory;
  op->directory = -1;
  if (close(directory) != 0) {
    const int saved = errno; reject_operation(op, "close-borrowed-directory", error_name(saved), saved);
  }
}

static bool property_string(napi_env env, napi_value object, const char *key, const char *text) {
  napi_value value;
  return napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value) == napi_ok &&
    napi_set_named_property(env, object, key, value) == napi_ok;
}

static bool property_unsigned(napi_env env, napi_value object, const char *key, uint64_t number) {
  napi_value value;
  return napi_create_bigint_uint64(env, number, &value) == napi_ok &&
    napi_set_named_property(env, object, key, value) == napi_ok;
}

static bool property_time(napi_env env, napi_value object, const char *key, struct timespec time) {
  int64_t seconds, nanoseconds;
  if (__builtin_mul_overflow((int64_t)time.tv_sec, INT64_C(1000000000), &seconds) ||
      __builtin_add_overflow(seconds, (int64_t)time.tv_nsec, &nanoseconds)) return false;
  napi_value value;
  return napi_create_bigint_int64(env, nanoseconds, &value) == napi_ok &&
    napi_set_named_property(env, object, key, value) == napi_ok;
}

static napi_value stat_value(napi_env env, const struct stat *info) {
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      !property_unsigned(env, result, "dev", (uint64_t)info->st_dev) ||
      !property_unsigned(env, result, "ino", (uint64_t)info->st_ino) ||
      !property_unsigned(env, result, "mode", (uint64_t)info->st_mode) ||
      !property_unsigned(env, result, "uid", (uint64_t)info->st_uid) ||
      !property_unsigned(env, result, "nlink", (uint64_t)info->st_nlink) ||
      !property_unsigned(env, result, "size", (uint64_t)info->st_size)) return NULL;
#ifdef __APPLE__
  if (!property_time(env, result, "mtimeNs", info->st_mtimespec) ||
      !property_time(env, result, "ctimeNs", info->st_ctimespec)) return NULL;
#else
  if (!property_time(env, result, "mtimeNs", info->st_mtim) ||
      !property_time(env, result, "ctimeNs", info->st_ctim)) return NULL;
#endif
  return result;
}

static void complete(napi_env env, napi_status status, void *data) {
  struct operation *op = data;
  if (status != napi_ok) reject_operation(op, "async-completion", "ERR_NATIVE_COMPLETION", 0);
  /* A non-executed work completion still owns its queue-time directory lease. */
  if (op->directory >= 0) {
    const int directory = op->directory;
    op->directory = -1;
    if (close(directory) != 0) {
      const int saved = errno; reject_operation(op, "close-borrowed-directory", error_name(saved), saved);
    }
  }
  napi_value result = NULL;
  if (op->code == NULL) {
    if (op->action == STAT_FILE) result = stat_value(env, &op->info);
    else if (napi_create_int32(env, op->opened, &result) != napi_ok) result = NULL;
    if (result == NULL) reject_operation(op, "encode-result", "ERR_NATIVE_RESULT", 0);
  }
  if (op->code == NULL && napi_resolve_deferred(env, op->deferred, result) == napi_ok) {
    op->opened = -1; /* Ownership transfers only after successful promise resolution. */
  } else {
    if (op->code == NULL) reject_operation(op, "resolve-result", "ERR_NATIVE_RESULT", 0);
    if (op->opened >= 0) { (void)close(op->opened); op->opened = -1; }
    napi_value message, error, number;
    if (napi_create_string_utf8(env, op->code, NAPI_AUTO_LENGTH, &message) == napi_ok &&
        napi_create_error(env, NULL, message, &error) == napi_ok) {
      (void)property_string(env, error, "code", op->code);
      (void)property_string(env, error, "syscall", op->stage);
      if (napi_create_int32(env, op->error, &number) == napi_ok) (void)napi_set_named_property(env, error, "errno", number);
      (void)napi_reject_deferred(env, op->deferred, error);
    }
  }
  (void)napi_delete_async_work(env, op->work);
  free(op);
}

static napi_value begin(napi_env env, napi_callback_info info) {
  size_t count = 4, length = 0;
  napi_value args[4], promise, resource;
  void *action_data;
  double directory_number;
  int directory;
  uint64_t device, inode;
  bool device_exact, inode_exact;
  char leaf[128];
  if (napi_get_cb_info(env, info, &count, args, NULL, &action_data) != napi_ok || count != 4 ||
      napi_get_value_double(env, args[0], &directory_number) != napi_ok || !isfinite(directory_number) ||
      directory_number < 0 || directory_number > INT_MAX || floor(directory_number) != directory_number ||
      napi_get_value_string_utf8(env, args[1], leaf, sizeof(leaf), &length) != napi_ok ||
      !allowed_leaf(leaf, length) ||
      napi_get_value_bigint_uint64(env, args[2], &device, &device_exact) != napi_ok || !device_exact ||
      napi_get_value_bigint_uint64(env, args[3], &inode, &inode_exact) != napi_ok || !inode_exact) {
    (void)napi_throw_type_error(env, "ERR_PUBLIC_DIRECTORY_ARGUMENT", "Expected an exact directory identity and private leaf");
    return NULL;
  }
  struct operation *op = calloc(1, sizeof(*op));
  if (op == NULL) { (void)napi_throw_error(env, "ENOMEM", "Public directory allocation failed"); return NULL; }
  op->action = (enum action)(intptr_t)action_data;
  directory = (int)directory_number;
  op->opened = -1;
  op->device = device; op->inode = inode;
  memcpy(op->leaf, leaf, length + 1);
  /* Duplicate synchronously before queueing: the worker never borrows a reusable integer. */
  op->directory = fcntl(directory, F_DUPFD_CLOEXEC, 0);
  if (op->directory < 0) {
    const int saved = errno;
    free(op); (void)napi_throw_error(env, error_name(saved), "Cannot borrow directory descriptor"); return NULL;
  }
  if (napi_create_promise(env, &op->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "boardroom-public-directory", NAPI_AUTO_LENGTH, &resource) != napi_ok ||
      napi_create_async_work(env, NULL, resource, execute, complete, op, &op->work) != napi_ok ||
      napi_queue_async_work(env, op->work) != napi_ok) {
    (void)close(op->directory);
    if (op->work != NULL) (void)napi_delete_async_work(env, op->work);
    free(op); (void)napi_throw_error(env, "ERR_NATIVE_QUEUE", "Cannot queue public directory operation"); return NULL;
  }
  return promise;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    { "createAt", NULL, begin, NULL, NULL, NULL, napi_default, (void *)(intptr_t)CREATE_FILE },
    { "readAt", NULL, begin, NULL, NULL, NULL, napi_default, (void *)(intptr_t)READ_FILE },
    { "statAt", NULL, begin, NULL, NULL, NULL, napi_default, (void *)(intptr_t)STAT_FILE }
  };
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
