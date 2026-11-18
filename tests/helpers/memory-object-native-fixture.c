/* Test-only translation unit. The normal build cannot select this source. */
#define MO_FIXTURE 1
#include "../../native/memory-objects.c"

static const char *fixture_points[] = {
  "open", "read", "write", "file-sync", "directory-sync", "publish-noreplace", "temporary-unlink", "file-close", "directory-close", "native-dispatch", "native-complete", "deadline"
};
static const char *fixture_point(const char *value) {
  for (size_t i = 0;i < sizeof(fixture_points)/sizeof(*fixture_points);i++)if (!strcmp(value, fixture_points[i]))return fixture_points[i];
  return NULL;
}
static napi_value fixture_open(napi_env env, napi_callback_info info) {
  napi_value args[3] = {
    NULL, NULL, NULL
  };
  size_t argc = 3;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char root[4097], storage[129];
  size_t n, length, maximum;
  if (!mo_scalar_string(env, args[0], root, sizeof(root), &n) || !mo_scalar_string(env, args[1], storage, sizeof(storage), &length) || !mo_storage(storage, length) || !mo_length(env, args[2], MO_MAX, &maximum))return mo_error(env, "invalid_input");
  struct stat actual;
  if (lstat(root, &actual) || !S_ISDIR(actual.st_mode))return mo_error(env, "root_changed");
  mo_root_selection selection = {
    root, actual.st_dev, actual.st_ino, storage, maximum
  };
  return mo_acquire_root(env, &selection);
}
/* The fixed intrinsic reads descriptors, so fixture data accessors are never invoked. */
static bool fixture_data(napi_env env, napi_value object, const char *key, napi_value *value) {
  napi_value global, constructor, fn, descriptor, args[2], getter, setter;
  if (napi_get_global(env, &global) != napi_ok || napi_get_named_property(env, global, "Object", &constructor) != napi_ok || napi_get_named_property(env, constructor, "getOwnPropertyDescriptor", &fn) != napi_ok)return false;
  args[0] = object;
  args[1] = mo_string(env, key);
  if (napi_call_function(env, constructor, fn, 2, args, &descriptor) != napi_ok) {
    napi_value error;
    napi_get_and_clear_last_exception(env, &error);
    return false;
  }
  napi_valuetype type;
  napi_typeof(env, descriptor, &type);
  if (type != napi_object)return false;
  bool has = false;
  napi_has_own_property(env, descriptor, mo_string(env, "value"), &has);
  if (!has)return false;
  napi_get_named_property(env, descriptor, "get", &getter);
  napi_get_named_property(env, descriptor, "set", &setter);
  napi_get_named_property(env, descriptor, "value", value);
  return true;
}
static napi_value fixture_faults(napi_env env, napi_callback_info info) {
  napi_value args[2] = {
    NULL, NULL
  };
  size_t argc = 2;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  mo_wrap *w = mo_owner(env, args[0], WR_ROOT);
  if (!w)return mo_error(env, "invalid_owner");
  bool array = false;
  uint32_t count = 0;
  if (!args[1] || napi_is_array(env, args[1], &array) != napi_ok || !array || napi_get_array_length(env, args[1], &count) != napi_ok || count > 8)return mo_error(env, "invalid_input");
  mo_plan plans[8] = {
    0
  };
  for (uint32_t i = 0;i < count;i++) {
    char key[16];
    snprintf(key, sizeof(key), "%u", i);
    napi_value item, p, o, a, e;
    if (!fixture_data(env, args[1], key, &item) || !fixture_data(env, item, "point", &p) || !fixture_data(env, item, "occurrence", &o) || !fixture_data(env, item, "action", &a))return mo_error(env, "invalid_input");
    char point[32], action[32], error[16];
    size_t n, occurrence;
    if (!mo_scalar_string(env, p, point, sizeof(point), &n) || !mo_scalar_string(env, a, action, sizeof(action), &n) || !mo_length(env, o, 256, &occurrence) || !occurrence)return mo_error(env, "invalid_input");
    plans[i].point = fixture_point(point);
    plans[i].occurrence =(unsigned)occurrence;
    plans[i].error = EIO;
    if (!strcmp(action, "fail-before"))plans[i].action = FA_FAIL;
    else if (!strcmp(action, "short-one"))plans[i].action = FA_SHORT;
    else if (!strcmp(action, "short-repeat"))plans[i].action = FA_REPEAT;
    else if (!strcmp(action, "zero"))plans[i].action = FA_ZERO;
    else if (!strcmp(action, "close-then-error"))plans[i].action = FA_CLOSED_ERROR;
    else if (!strcmp(action, "error-without-close"))plans[i].action = FA_OPEN_ERROR;
    else if (!strcmp(action, "hold"))plans[i].action = FA_HOLD;
    else return mo_error(env, "invalid_input");
    if (!plans[i].point)return mo_error(env, "invalid_input");
    if (fixture_data(env, item, "errno", &e)) {
      if (!mo_scalar_string(env, e, error, sizeof(error), &n))return mo_error(env, "invalid_input");
      if (!strcmp(error, "EIO"))plans[i].error = EIO;
      else if (!strcmp(error, "ENOSYS"))plans[i].error = ENOSYS;
      else if (!strcmp(error, "ENOTSUP"))plans[i].error = ENOTSUP;
      else if (!strcmp(error, "EXDEV"))plans[i].error = EXDEV;
      else return mo_error(env, "invalid_input");
    }
    bool io = !strcmp(point, "read") || !strcmp(point, "write"), close_point = !strcmp(point, "file-close") || !strcmp(point, "directory-close");
    if (((plans[i].action == FA_SHORT || plans[i].action == FA_REPEAT || plans[i].action == FA_ZERO) && !io) ||((plans[i].action == FA_CLOSED_ERROR || plans[i].action == FA_OPEN_ERROR) && !close_point))return mo_error(env, "invalid_input");
  }
  pthread_mutex_lock(&mo_mutex);
  if (w->root->tasks) {
    pthread_mutex_unlock(&mo_mutex);
    return mo_error(env, "resource_unavailable");
  }
  memcpy(w->root->plans, plans, sizeof(plans));
  w->root->plan_count = count;
  pthread_mutex_unlock(&mo_mutex);
  return mo_null(env);
}
static napi_value fixture_release(napi_env env, napi_callback_info info) {
  napi_value args[2] = {
    NULL, NULL
  };
  size_t argc = 2;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  mo_wrap *w = mo_owner(env, args[0], WR_ROOT);
  char point[32];
  size_t n;
  if (!w)return mo_error(env, "invalid_owner");
  if (!mo_scalar_string(env, args[1], point, sizeof(point), &n) || !fixture_point(point))return mo_error(env, "invalid_input");
  pthread_mutex_lock(&mo_mutex);
  for (unsigned i = 0;i < w->root->plan_count;i++)if (!strcmp(w->root->plans[i].point, point))w->root->plans[i].released = true;
  pthread_cond_broadcast(&mo_condition);
  pthread_mutex_unlock(&mo_mutex);
  return mo_null(env);
}
static napi_value fixture_fds(napi_env env, napi_callback_info info) {
  napi_value arg = NULL;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  mo_wrap *w = mo_owner(env, arg, WR_ROOT);
  if (!w)return mo_error(env, "invalid_owner");
  mo_fd snapshot[MO_FDS];
  pthread_mutex_lock(&mo_mutex);
  memcpy(snapshot, w->root->fds, sizeof(snapshot));
  pthread_mutex_unlock(&mo_mutex);
  napi_value array;
  napi_create_array(env, &array);
  unsigned index = 0;
  const char *states[] = {
    "free", "reserved", "owned", "closing", "unknown"
  };
  for (int i = 0;i < MO_FDS;i++) {
    const mo_fd *fd = &snapshot[i];
    if (fd->state == FD_FREE)continue;
    napi_value v = mo_object(env);
    mo_set(env, v, "fd", mo_number(env, fd->fd));
    mo_set(env, v, "state", mo_string(env, states[fd->state]));
    mo_set(env, v, "role", mo_string(env, fd->role));
    mo_index(env, array, index++, mo_freeze(env, v));
  }
  return mo_freeze(env, array);
}
static napi_value fixture_fill(napi_env env, napi_callback_info info) {
  napi_value arg = NULL;
  size_t argc = 1;
  mo_env *e = NULL;
  napi_get_cb_info(env, info, &argc, &arg, NULL,(void **)&e);
  mo_wrap *w = mo_owner(env, arg, WR_ROOT);
  if (!w)return mo_error(env, "invalid_owner");
  const char *error = NULL;
  mo_op *op = mo_new_op(w->root, e, &error);
  if (!op)return mo_error(env, error);
  mo_result result = {
    0
  };
  for (;;) {
    int slot = mo_reserve(w->root, op, "fixture-dup", &result);
    if (slot < 0)break;
    int fd = fcntl(mo_descriptor(w->root, w->root->root_dir), F_DUPFD_CLOEXEC, 0), err = fd < 0 ? errno : 0;
    mo_record(op, "reserve-fd", "fcntl-dup", F_DUPFD_CLOEXEC, fd < 0 ? -1 : 0, err, false);
    mo_acquired(w->root, slot, fd);
    if (fd < 0) {
      mo_fail(&result, "native_io", "reserve-fd", "status", -1, err);
      mo_op_cleanup(op, &result);
      mo_abandon(op);
      return mo_error(env, "native_io");
    }
  }
  pthread_mutex_lock(&mo_mutex);
  op->dispatching = false;
  w->root->dispatching--;
  pthread_mutex_unlock(&mo_mutex);
  return mo_wrap_owner(env, e, w->root, op, WR_HOLD);
}
static napi_value fixture_close_hold(napi_env env, napi_callback_info info) {
  napi_value arg = NULL;
  size_t argc = 1;
  mo_env *e = NULL;
  napi_get_cb_info(env, info, &argc, &arg, NULL,(void **)&e);
  mo_wrap *w = mo_owner(env, arg, WR_HOLD);
  if (!w)return mo_error(env, "invalid_owner");
  mo_result result = {
    0
  };
  mo_op_cleanup(w->op, &result);
  if (!mo_retains_op(w->op)) {
    pthread_mutex_lock(&mo_mutex);
    w->op->pending = false;
    pthread_mutex_unlock(&mo_mutex);
  }
  if (result.first.code)return mo_failure(env, e, w->root, &result);
  napi_value v = mo_object(env);
  mo_set(env, v, "kind", mo_string(env, "closed"));
  mo_set(env, v, "resources", mo_resources(env, w->root));
  return mo_freeze(env, v);
}
static napi_value fixture_trace(napi_env env, napi_callback_info info) {
  napi_value arg = NULL;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  mo_wrap *w = mo_owner(env, arg, WR_ROOT);
  if (!w)return mo_error(env, "invalid_owner");
  mo_trace *snapshot = calloc(8192, sizeof(*snapshot));
  if (!snapshot)return mo_error(env, "resource_unavailable");
  pthread_mutex_lock(&mo_mutex);
  bool overflow = w->root->trace_overflow;
  unsigned count = w->root->trace_count;
  memcpy(snapshot, w->root->trace, count*sizeof(*snapshot));
  pthread_mutex_unlock(&mo_mutex);
  if (overflow) {
    free(snapshot);
    return mo_error(env, "resource_unavailable");
  }
  napi_value array;
  napi_create_array_with_length(env, count, &array);
  for (unsigned i = 0;i < count;i++) {
    const mo_trace *t = &snapshot[i];
    napi_value v = mo_object(env);
    mo_set(env, v, "point", mo_string(env, t->point));
    mo_set(env, v, "syscall", mo_string(env, t->syscall));
    mo_set(env, v, "rc", mo_number(env,(double)t->rc));
    mo_set(env, v, "errno", mo_number(env, t->error));
    mo_set(env, v, "flags", mo_number(env, t->flags));
    mo_set(env, v, "injected", mo_bool(env, t->injected));
    mo_set(env, v, "operation", mo_number(env,(double)t->operation));
    mo_set(env, v, "calls", mo_number(env, t->calls));
    mo_index(env, array, i, mo_freeze(env, v));
  }
  free(snapshot);
  return mo_freeze(env, array);
}
static napi_value fixture_init(napi_env env, napi_value exports) {
  if (!mo_init(env, exports))return NULL;
  mo_env *e = NULL;
  napi_get_instance_data(env,(void **)&e);
  const char *names[] = {
    "fixtureOpenRoot", "fixtureSetFaults", "fixtureRelease", "fixtureFdSnapshot", "fixtureFillFdBoundary", "fixtureCloseFdHold", "fixtureTrace"
  };
  napi_callback functions[] = {
    fixture_open, fixture_faults, fixture_release, fixture_fds, fixture_fill, fixture_close_hold, fixture_trace
  };
  for (unsigned i = 0;i < 7;i++) {
    napi_value fn;
    napi_create_function(env, names[i], NAPI_AUTO_LENGTH, functions[i], e, &fn);
    mo_set(env, exports, names[i], fn);
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, fixture_init)
