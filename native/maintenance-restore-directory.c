/* #152 file restore: only one leaf relative to an already pinned private directory. */
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

enum action { CREATE_FILE, READ_FILE, OPEN_DIRECTORY, MAKE_DIRECTORY };
struct operation {
  napi_async_work work;
  napi_deferred deferred;
  enum action action;
  int directory;
  int opened;
  char leaf[4097];
  uint64_t device;
  uint64_t inode;
  struct stat info;
  const char *stage;
  const char *code;
  int error;
  bool created;
  struct { const char *stage; int error; } close_errors[2];
  size_t close_error_count;
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

static void close_failed(struct operation *op, const char *stage, int error) {
  if (op->close_error_count < 2) {
    op->close_errors[op->close_error_count].stage = stage;
    op->close_errors[op->close_error_count++].error = error;
  }
  reject_operation(op, stage, error_name(error), error);
}

static bool allowed_leaf(const char *leaf, size_t length) {
  return length > 0 && length <= 4096 && memchr(leaf, '\0', length) == NULL &&
    memchr(leaf, '/', length) == NULL && strcmp(leaf, ".") != 0 && strcmp(leaf, "..") != 0;
}

static bool check_directory(struct operation *op) {
  struct stat current;
  if (fstat(op->directory, &current) != 0) {
    const int saved = errno; reject_operation(op, "fstat-directory", error_name(saved), saved); return false;
  }
  if (!S_ISDIR(current.st_mode) || current.st_uid != getuid() || (current.st_mode & 07777) != 0700 ||
      (uint64_t)current.st_dev != op->device || (uint64_t)current.st_ino != op->inode) {
    reject_operation(op, "directory-identity", "ERR_DIRECTORY_IDENTITY", 0); return false;
  }
  return true;
}

static bool check_opened(struct operation *op) {
  const struct stat *info = &op->info;
  const bool directory = op->action == OPEN_DIRECTORY;
  if (info->st_uid != getuid() || (info->st_mode & 07777) != (directory ? 0700 : 0600) ||
      (directory ? !S_ISDIR(info->st_mode) : !S_ISREG(info->st_mode) || info->st_nlink != 1 || info->st_size < 0)) {
    reject_operation(op, "opened-identity", "ERR_FILE_IDENTITY", 0); return false;
  }
  return true;
}

static void execute(napi_env env, void *data) {
  (void)env;
  struct operation *op = data;
  if (check_directory(op)) {
    if (op->action == MAKE_DIRECTORY) {
      if (mkdirat(op->directory, op->leaf, 0700) != 0) {
        const int saved = errno; reject_operation(op, "mkdirat", error_name(saved), saved);
      } else op->created = true;
    } else {
      const int flags = O_NOFOLLOW | O_CLOEXEC |
        (op->action == CREATE_FILE ? O_CREAT | O_EXCL | O_RDWR :
          O_RDONLY | O_NONBLOCK | (op->action == OPEN_DIRECTORY ? O_DIRECTORY : 0));
      op->opened = openat(op->directory, op->leaf, flags, 0600);
      if (op->opened < 0) {
        const int saved = errno; reject_operation(op, "openat", error_name(saved), saved);
      } else if (fstat(op->opened, &op->info) != 0) {
        const int saved = errno; reject_operation(op, "fstat-opened", error_name(saved), saved);
      } else (void)check_opened(op);
    }
    if (op->code == NULL) (void)check_directory(op);
  }
  const int directory = op->directory;
  op->directory = -1;
  if (close(directory) != 0) {
    const int saved = errno; close_failed(op, "close-borrowed-directory", saved);
  }
}

static bool property_string(napi_env env, napi_value object, const char *key, const char *text) {
  napi_value value;
  return napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value) == napi_ok &&
    napi_set_named_property(env, object, key, value) == napi_ok;
}

static void complete(napi_env env, napi_status status, void *data) {
  struct operation *op = data;
  if (status != napi_ok) reject_operation(op, "async-completion", "ERR_NATIVE_COMPLETION", 0);
  /* A non-executed work completion still owns its queue-time directory lease. */
  if (op->directory >= 0) {
    const int directory = op->directory;
    op->directory = -1;
    if (close(directory) != 0) {
      const int saved = errno; close_failed(op, "close-borrowed-directory", saved);
    }
  }
  napi_value result = NULL;
  if (op->code == NULL) {
    if (op->action == MAKE_DIRECTORY) { if (napi_get_undefined(env, &result) != napi_ok) result = NULL; }
    else if (napi_create_int32(env, op->opened, &result) != napi_ok) result = NULL;
    if (result == NULL) reject_operation(op, "encode-result", "ERR_NATIVE_RESULT", 0);
  }
  if (op->code == NULL && napi_resolve_deferred(env, op->deferred, result) == napi_ok) {
    op->opened = -1; /* Ownership transfers only after successful promise resolution. */
  } else {
    if (op->code == NULL) reject_operation(op, "resolve-result", "ERR_NATIVE_RESULT", 0);
    if (op->opened >= 0) {
      const int opened = op->opened; op->opened = -1;
      if (close(opened) != 0) { const int saved = errno; close_failed(op, "close-opened", saved); }
    }
    napi_value message, error, number;
    if (napi_create_string_utf8(env, op->code, NAPI_AUTO_LENGTH, &message) == napi_ok &&
        napi_create_error(env, NULL, message, &error) == napi_ok) {
      (void)property_string(env, error, "code", op->code);
      (void)property_string(env, error, "syscall", op->stage);
      napi_value created;
      if (napi_get_boolean(env, op->created, &created) == napi_ok) (void)napi_set_named_property(env, error, "created", created);
      if (napi_create_int32(env, op->error, &number) == napi_ok) (void)napi_set_named_property(env, error, "errno", number);
      napi_value close_errors;
      if (napi_create_array_with_length(env, op->close_error_count, &close_errors) == napi_ok) {
        for (size_t i = 0; i < op->close_error_count; i++) {
          napi_value item;
          if (napi_create_object(env, &item) != napi_ok) continue;
          (void)property_string(env, item, "syscall", op->close_errors[i].stage);
          (void)property_string(env, item, "code", error_name(op->close_errors[i].error));
          if (napi_create_int32(env, op->close_errors[i].error, &number) == napi_ok) (void)napi_set_named_property(env, item, "errno", number);
          (void)napi_set_element(env, close_errors, (uint32_t)i, item);
        }
        (void)napi_set_named_property(env, error, "closeErrors", close_errors);
      }
      (void)napi_reject_deferred(env, op->deferred, error);
    }
  }
  (void)napi_delete_async_work(env, op->work);
  free(op);
}

static napi_value begin(napi_env env, napi_callback_info info) {
  size_t count = 4, length = 0, copied = 0;
  napi_value args[4], promise, resource;
  void *action_data;
  double directory_number;
  int directory;
  uint64_t device, inode;
  bool device_exact, inode_exact;
  char leaf[4097];
  if (napi_get_cb_info(env, info, &count, args, NULL, &action_data) != napi_ok || count != 4 ||
      napi_get_value_double(env, args[0], &directory_number) != napi_ok || !isfinite(directory_number) ||
      directory_number < 0 || directory_number > INT_MAX || floor(directory_number) != directory_number ||
      napi_get_value_string_utf8(env, args[1], NULL, 0, &length) != napi_ok || length == 0 || length > 4096 ||
      napi_get_value_string_utf8(env, args[1], leaf, sizeof(leaf), &copied) != napi_ok || copied != length ||
      !allowed_leaf(leaf, length) ||
      napi_get_value_bigint_uint64(env, args[2], &device, &device_exact) != napi_ok || !device_exact ||
      napi_get_value_bigint_uint64(env, args[3], &inode, &inode_exact) != napi_ok || !inode_exact) {
    (void)napi_throw_type_error(env, "ERR_RESTORE_DIRECTORY_ARGUMENT", "Expected an exact directory identity and single leaf");
    return NULL;
  }
  struct operation *op = calloc(1, sizeof(*op));
  if (op == NULL) { (void)napi_throw_error(env, "ENOMEM", "Restore directory allocation failed"); return NULL; }
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
      napi_create_string_utf8(env, "boardroom-restore-directory", NAPI_AUTO_LENGTH, &resource) != napi_ok ||
      napi_create_async_work(env, NULL, resource, execute, complete, op, &op->work) != napi_ok ||
      napi_queue_async_work(env, op->work) != napi_ok) {
    (void)close(op->directory);
    if (op->work != NULL) (void)napi_delete_async_work(env, op->work);
    free(op); (void)napi_throw_error(env, "ERR_NATIVE_QUEUE", "Cannot queue restore directory operation"); return NULL;
  }
  return promise;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    { "createAt", NULL, begin, NULL, NULL, NULL, napi_default, (void *)(intptr_t)CREATE_FILE },
    { "readAt", NULL, begin, NULL, NULL, NULL, napi_default, (void *)(intptr_t)READ_FILE },
    { "openDirectoryAt", NULL, begin, NULL, NULL, NULL, napi_default, (void *)(intptr_t)OPEN_DIRECTORY },
    { "mkdirAt", NULL, begin, NULL, NULL, NULL, napi_default, (void *)(intptr_t)MAKE_DIRECTORY }
  };
  if (napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
