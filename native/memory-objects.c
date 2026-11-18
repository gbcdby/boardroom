#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <node_api.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <math.h>
#ifdef __linux__
#include <sys/syscall.h>
#include <linux/openat2.h>
#include <sys/random.h>
#include <sys/vfs.h>
#else
#include <sys/mount.h>
#endif

#define MO_MAX 1048576u
#define MO_BLOCK 65536u
#define MO_FDS 64
#define MO_OPS 8
#define MO_CALLS 256u
#define MO_UNUSED __attribute__((unused))

typedef struct mo_root mo_root;
typedef struct mo_op mo_op;
typedef struct mo_env mo_env;
typedef struct mo_wrap mo_wrap;
typedef struct mo_job mo_job;
typedef struct {
  const char *code, *stage, *kind;
  int64_t rc;
  int error;
} mo_fact;
typedef struct {
  mo_fact first, cleanup[64];
  unsigned count;
} mo_result;
typedef enum {
  FD_FREE, FD_RESERVED, FD_OWNED, FD_CLOSING, FD_UNKNOWN
} mo_fd_state;
typedef struct {
  mo_fd_state state;
  int fd;
  const char *role;
  void *owner;
  struct stat identity;
} mo_fd;
typedef struct {
  int slot, parent;
  char leaf[256];
  struct stat identity;
  bool private_dir;
} mo_dir;
typedef enum {
  ROOT_OPEN, ROOT_CLOSING, ROOT_RETAINED, ROOT_CLOSED
} mo_root_state;
typedef enum {
  WR_ROOT, WR_FILE, WR_CLEANUP, WR_HOLD
} mo_wrap_kind;
typedef enum {
  JOB_PREPARE, JOB_READ, JOB_CHECK, JOB_CLOSE_FILE, JOB_CLOSE_ROOT
} mo_job_kind;
#ifdef MO_FIXTURE
typedef enum {
  FA_NONE, FA_FAIL, FA_SHORT, FA_REPEAT, FA_ZERO, FA_CLOSED_ERROR, FA_OPEN_ERROR, FA_HOLD
} mo_action;
typedef struct {
  const char *point;
  unsigned occurrence, seen;
  mo_action action;
  int error;
  bool released;
} mo_plan;
typedef struct {
  const char *point, *syscall;
  int64_t rc;
  int error, flags;
  bool injected;
  uint64_t operation;
  unsigned calls;
} mo_trace;
#else
typedef enum {
  FA_NONE, FA_FAIL, FA_SHORT, FA_REPEAT, FA_ZERO, FA_CLOSED_ERROR, FA_OPEN_ERROR, FA_HOLD
} mo_action;
#endif
struct mo_op {
  mo_root *root;
  mo_env *environment;
  mo_op *next;
  uint64_t serial;
  unsigned calls, refs;
  struct timespec started;
  bool pending, active, prepared, reused, temporary_exists, expired, cleanup_pending, dispatching;
  unsigned char *body;
  size_t length;
  char digest[65], leaf[68], temporary[39];
  int shard, file, writer;
  struct stat temporary_identity;
};
struct mo_root {
  mo_root *next;
  uint64_t generation;
  dev_t device;
  ino_t inode;
  mo_root_state state;
  bool close_running;
  unsigned refs, wrappers, tasks, acquiring, dispatching, control_tasks, close_reserved;
  char storage[129], path[4097];
  size_t maximum;
  mo_fd fds[MO_FDS];
  mo_dir dirs[35];
  unsigned dir_count;
  int root_dir, objects, sha256, staging;
  mo_op *operations;
#ifdef MO_FIXTURE
  mo_plan plans[8];
  unsigned plan_count;
  mo_trace *trace;
  unsigned trace_count;
  bool trace_overflow;
#endif
};
struct mo_wrap {
  mo_wrap *next, *env_next;
  mo_root *root;
  mo_op *op;
  mo_env *environment;
  uint64_t generation;
  mo_wrap_kind kind;
  bool active;
};
struct mo_env {
  napi_env napi;
  napi_async_cleanup_hook_handle hook;
  napi_async_work cleanup_work;
  bool closing, cleanup_queued, cleanup_done;
  unsigned jobs, refs;
  mo_wrap *wrappers;
  mo_job *work;
};
struct mo_job {
  mo_job *next;
  mo_root *root;
  mo_op *op;
  mo_env *environment;
  mo_job_kind kind;
  napi_async_work work;
  napi_ref owner_ref, promise_ref;
  bool retry;
  struct timespec started;
  napi_deferred deferred;
  mo_result result;
};
static pthread_mutex_t mo_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t mo_condition = PTHREAD_COND_INITIALIZER;
static mo_root *mo_roots;
static mo_wrap *mo_wrappers;
static uint64_t mo_generation, mo_serial;
static const napi_type_tag mo_tags[] = {
  {
    UINT64_C(0x76e3b715667e4bda), UINT64_C(0x810f35e9ba122fe1)
  }, {
    UINT64_C(0x76e3b715667e4bda), UINT64_C(0x810f35e9ba122fe2)
  }, {
    UINT64_C(0x76e3b715667e4bda), UINT64_C(0x810f35e9ba122fe3)
  }, {
    UINT64_C(0x76e3b715667e4bda), UINT64_C(0x810f35e9ba122fe4)
  }
};
static pthread_once_t mo_pin_once = PTHREAD_ONCE_INIT;
static void *mo_self_handle;
static const unsigned char mo_image_anchor = 0;
static void mo_pin_image(void) {
  Dl_info own, entry;
  if (!dladdr(&mo_image_anchor, &own) || !own.dli_fname || !own.dli_fbase) return;
  void *candidate = dlopen(own.dli_fname, RTLD_NOLOAD | RTLD_NOW | RTLD_LOCAL);
  if (!candidate) return;
#ifdef MO_FIXTURE_PIN_FAILURE
  void *symbol = dlsym(candidate, "boardroom_missing_pin_sentinel");
#elif defined(MO_FIXTURE_PIN_WRONG_IMAGE)
  void *symbol = dlsym(candidate, "malloc");
#else
  void *symbol = dlsym(candidate, "napi_register_module_v1");
#endif
  if (!symbol || !dladdr(symbol, &entry) || entry.dli_fbase != own.dli_fbase) {
    dlclose(candidate);
    return;
  }
  mo_self_handle = candidate;
  /* Never released by an environment or root. */
}

/* SHA-256 (FIPS 180-4), byte counts and arithmetic are explicitly bounded. */
typedef struct {
  uint32_t h[8];
  uint64_t bytes;
  size_t used;
  unsigned char block[64];
} mo_sha;
static uint32_t mo_rotr(uint32_t x, unsigned n) {
  return(x >> n) |(x <<(32 - n));
}
static void mo_sha_block(mo_sha *s, const unsigned char *p) {
  static const uint32_t k[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  };
  uint32_t w[64];
  for (unsigned i = 0;i < 16;i++) w[i] =(uint32_t)p[4*i]<<24|(uint32_t)p[4*i+1]<<16|(uint32_t)p[4*i+2]<<8|p[4*i+3];
  for (unsigned i = 16;i < 64;i++) {
    uint32_t a = w[i-15], b = w[i-2];
    w[i] = w[i-16]+(mo_rotr(a, 7)^mo_rotr(a, 18)^(a>>3))+w[i-7]+(mo_rotr(b, 17)^mo_rotr(b, 19)^(b>>10));
  }
  uint32_t a = s->h[0], b = s->h[1], c = s->h[2], d = s->h[3], e = s->h[4], f = s->h[5], g = s->h[6], h = s->h[7];
  for (unsigned i = 0;i < 64;i++) {
    uint32_t t = h+(mo_rotr(e, 6)^mo_rotr(e, 11)^mo_rotr(e, 25))+((e&f)^(~e&g))+k[i]+w[i];
    uint32_t u =(mo_rotr(a, 2)^mo_rotr(a, 13)^mo_rotr(a, 22))+((a&b)^(a&c)^(b&c));
    h = g;
    g = f;
    f = e;
    e = d+t;
    d = c;
    c = b;
    b = a;
    a = t+u;
  }
  s->h[0] += a;
  s->h[1] += b;
  s->h[2] += c;
  s->h[3] += d;
  s->h[4] += e;
  s->h[5] += f;
  s->h[6] += g;
  s->h[7] += h;
}
static void mo_sha_init(mo_sha *s) {
  const uint32_t h[8] = {
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  };
  memset(s, 0, sizeof(*s));
  memcpy(s->h, h, sizeof(h));
}
static void mo_sha_add(mo_sha *s, const unsigned char *p, size_t n) {
  s->bytes += n;
  while (n) {
    size_t take = 64-s->used;
    if (take > n)take = n;
    memcpy(s->block+s->used, p, take);
    s->used += take;
    p += take;
    n -= take;
    if (s->used == 64) {
      mo_sha_block(s, s->block);
      s->used = 0;
    }
  }
}
static void mo_sha_end(mo_sha *s, char out[65]) {
  uint64_t bits = s->bytes*8;
  s->block[s->used++] = 0x80;
  if (s->used > 56) {
    memset(s->block+s->used, 0, 64-s->used);
    mo_sha_block(s, s->block);
    s->used = 0;
  }
  memset(s->block+s->used, 0, 56-s->used);
  for (unsigned i = 0;i < 8;i++)s->block[63-i] =(unsigned char)(bits>>(8*i));
  mo_sha_block(s, s->block);
  static const char hex[] = "0123456789abcdef";
  for (unsigned i = 0;i < 32;i++) {
    unsigned char b =(unsigned char)(s->h[i/4]>>(24-8*(i%4)));
    out[i*2] = hex[b>>4];
    out[i*2+1] = hex[b&15];
  }
  out[64] = 0;
}
static void mo_digest(const unsigned char *p, size_t n, char out[65]) {
  mo_sha s;
  mo_sha_init(&s);
  mo_sha_add(&s, p, n);
  mo_sha_end(&s, out);
}

typedef struct mo_js_frame {
  napi_status status;
  struct mo_js_frame *previous;
} mo_js_frame;
static _Thread_local mo_js_frame *mo_js_current;
static void mo_note(napi_status status) {
  if (status != napi_ok && mo_js_current && mo_js_current->status == napi_ok)mo_js_current->status = status;
}
static void mo_js_begin(mo_js_frame *frame) {
  frame->status = napi_ok;
  frame->previous = mo_js_current;
  mo_js_current = frame;
}
static void mo_js_end(mo_js_frame *frame) {
  mo_js_current = frame->previous;
}
static napi_value mo_null(napi_env env) {
  napi_value v = NULL;
  mo_note(napi_get_null(env, &v));
  return v;
}
static napi_value mo_string(napi_env env, const char *s) {
  napi_value v = NULL;
  mo_note(napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v));
  return v;
}
static napi_value mo_number(napi_env env, double n) {
  napi_value v = NULL;
  mo_note(napi_create_double(env, n, &v));
  return v;
}
static MO_UNUSED napi_value mo_bool(napi_env env, bool b) {
  napi_value v = NULL;
  mo_note(napi_get_boolean(env, b, &v));
  return v;
}
static napi_value mo_object(napi_env env) {
  napi_value v = NULL;
  mo_note(napi_create_object(env, &v));
  return v;
}
/* Own data properties avoid calling setters on Object.prototype. */
static void mo_set(napi_env env, napi_value object, const char *key, napi_value value) {
  if (!object || !value) {
    mo_note(napi_generic_failure);
    return;
  }
  napi_property_descriptor property = {
    .utf8name = key,.value = value,.attributes = napi_writable|napi_enumerable|napi_configurable
  };
  mo_note(napi_define_properties(env, object, 1, &property));
}
/* Promise resolution must never read Object.prototype.then. This inert own
   non-enumerable field is a result-envelope barrier, never an ObjectRef field. */
static napi_value mo_result_object(napi_env env) {
  napi_value object = mo_object(env), undefined = NULL;
  mo_note(napi_get_undefined(env, &undefined));
  if (object && undefined) {
    napi_property_descriptor property = {
      .utf8name = "then",.value = undefined,.attributes = napi_default
    };
    mo_note(napi_define_properties(env, object, 1, &property));
  } else mo_note(napi_generic_failure);
  return object;
}
static void mo_index(napi_env env, napi_value array, uint32_t index, napi_value value) {
  char key[16];
  snprintf(key, sizeof(key), "%u", index);
  mo_set(env, array, key, value);
}
static napi_value mo_freeze(napi_env env, napi_value v) {
  if (v)mo_note(napi_object_freeze(env, v));
  else mo_note(napi_generic_failure);
  return v;
}
static napi_value mo_error(napi_env env, const char *code) {
  char message[100];
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    napi_value ignored;
    napi_get_and_clear_last_exception(env, &ignored);
  }
  snprintf(message, sizeof(message), "memory_native:%s", code);
  napi_value text = mo_string(env, message), error = NULL, fixed_code = mo_string(env, code);
  if (!text || !fixed_code)return NULL;
  /* Passing code to napi_throw_error uses an inherited-property Set in Node.
     Define our own data property before throwing the fixed Error instead. */
  napi_status status = napi_create_error(env, NULL, text, &error);
  mo_note(status);
  if (status != napi_ok)return NULL;
  napi_property_descriptor property = {.utf8name = "code", .value = fixed_code,
      .attributes = napi_writable | napi_enumerable | napi_configurable};
  status = napi_define_properties(env, error, 1, &property);
  mo_note(status);
  if (status == napi_ok)mo_note(napi_throw(env, error));
  return NULL;
}
static void mo_fail(mo_result *r, const char *code, const char *stage, const char *kind, int64_t rc, int error) {
  mo_fact fact = {
    code, stage, kind, rc, error
  };
  if (!r->first.code)r->first = fact;
  else if (r->count < 64)r->cleanup[r->count++] = fact;
}
static void mo_logic(mo_result *r, const char *code, const char *stage) {
  mo_fail(r, code, stage, "not-run", 0, 0);
}
static bool mo_same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static bool mo_private(const struct stat *s, bool dir) {
  return(dir ? S_ISDIR(s->st_mode) : S_ISREG(s->st_mode)) && s->st_uid == geteuid() &&(s->st_mode&07777) ==(dir ? 0700 : 0600) &&(dir || s->st_nlink == 1);
}
static bool mo_hex(const char *s, size_t n) {
  if (n != 64)return false;
  for (size_t i = 0;i < n;i++)if (!((s[i] >= '0' && s[i] <= '9') ||(s[i] >= 'a' && s[i] <= 'f')))return false;
  return true;
}
static bool mo_storage(const char *s, size_t n) {
  if (!n || n > 128)return false;
  for (size_t i = 0;i < n;i++) {
    char c = s[i];
    bool alnum =(c >= 'a' && c <= 'z') ||(c >= 'A' && c <= 'Z') ||(c >= '0' && c <= '9');
    if (!alnum &&(i == 0 || !strchr("._:-", c) || !c))return false;
  }
  return true;
}
static void mo_record(mo_op *op, const char *point, const char *syscall, int flags, int64_t rc, int error, bool injected) {
#ifdef MO_FIXTURE
  mo_root *r = op->root;
  pthread_mutex_lock(&mo_mutex);
  if (r->trace_count < 8192)r->trace[r->trace_count++] =(mo_trace) {
    point, syscall, rc, error, flags, injected, op->serial, op->calls
  };
  else r->trace_overflow = true;
  pthread_mutex_unlock(&mo_mutex);
#else
  (void)op;
  (void)point;
  (void)syscall;
  (void)flags;
  (void)rc;
  (void)error;
  (void)injected;
#endif
}
static mo_action mo_fault(mo_op *op, const char *point, int *error) {
#ifdef MO_FIXTURE
  mo_action action = FA_NONE;
  mo_root *r = op->root;
  pthread_mutex_lock(&mo_mutex);
  for (unsigned i = 0;i < r->plan_count;i++) {
    mo_plan *p = &r->plans[i];
    if (strcmp(p->point, point) ||((!strcmp(point, "native-dispatch") || !strcmp(point, "native-complete")) && p->action == FA_FAIL))continue;
    p->seen++;
    if (p->action == FA_REPEAT ? p->seen < p->occurrence : p->seen != p->occurrence)continue;
    action = p->action;
    *error = p->error;
    if (action == FA_HOLD) {
      if (r->trace_count < 8192)r->trace[r->trace_count++] =(mo_trace) {
        point, "fixture-hold", 0, 0, 0, true, op->serial, op->calls
      };
      else r->trace_overflow = true;
    } while (action == FA_HOLD && !p->released)pthread_cond_wait(&mo_condition, &mo_mutex);
    if (action == FA_HOLD)action = FA_NONE;
    break;
  }
  pthread_mutex_unlock(&mo_mutex);
  return action;
#else
  (void)op;
  (void)point;
  (void)error;
  return FA_NONE;
#endif
}
static bool mo_gate(mo_op *op, mo_result *out, const char *stage) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  if (op->expired || now.tv_sec-op->started.tv_sec >= 120) {
    mo_logic(out, "deadline_exceeded", stage);
    return false;
  }
  if (op->calls >= MO_CALLS) {
    mo_logic(out, "native_call_limit", stage);
    return false;
  }
  op->calls++;
  return true;
}
static int mo_reserve(mo_root *r, void *owner, const char *role, mo_result *out) {
  pthread_mutex_lock(&mo_mutex);
  int slot = -1;
  for (int i = 0;i < MO_FDS;i++)if (r->fds[i].state == FD_FREE) {
    slot = i;
    r->fds[i] =(mo_fd) {
      .state = FD_RESERVED,.fd = -1,.owner = owner,.role = role
    };
    break;
  }
  pthread_mutex_unlock(&mo_mutex);
  if (slot < 0)mo_logic(out, "resource_unavailable", "reserve-fd");
  return slot;
}
static void mo_acquired(mo_root *r, int slot, int fd) {
  pthread_mutex_lock(&mo_mutex);
  r->fds[slot].fd = fd;
  r->fds[slot].state = fd < 0 ? FD_FREE : FD_OWNED;
  pthread_mutex_unlock(&mo_mutex);
}
static int mo_descriptor(mo_root *r, int slot) {
  return slot < 0 ? -1 : r->fds[slot].fd;
}
static int mo_open(mo_op *op, int parent, const char *leaf, int flags, mode_t mode, bool inside, const char *stage, mo_result *out) {
  int slot = mo_reserve(op->root, op, stage, out);
  if (slot < 0)return -1;
  if (!mo_gate(op, out, stage)) {
    mo_acquired(op->root, slot, -1);
    return -1;
  }
  int e = EIO;
  mo_action action = mo_fault(op, "open", &e);
  int fd = -1;
  if (action != FA_FAIL) {
#ifdef __linux__
    struct open_how how = {
      .flags =(uint64_t)flags,.mode =(uint64_t)mode,.resolve = RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|(inside ? RESOLVE_NO_XDEV : 0)
    };
    if (parent == AT_FDCWD && strcmp(leaf, "/") == 0)fd = open("/", flags);
    else fd =(int)syscall(SYS_openat2, parent, leaf, &how, sizeof(how));
#else
    (void)inside;
    fd = openat(parent, leaf, flags, mode);
#endif
    e = fd < 0 ? errno : 0;
  }
  mo_record(op, stage, "open", flags, fd, e, action != FA_NONE);
  mo_acquired(op->root, slot, fd);
  if (fd < 0) {
    mo_fail(out,(e == ENOSYS || e == ENOTSUP) ? "native_abi_unavailable" : "native_io", stage, "status", -1, e);
    return -1;
  }
  return slot;
}
static bool mo_fstat(mo_op *op, int slot, struct stat *s, const char *stage, mo_result *out) {
  if (!mo_gate(op, out, stage))return false;
  int rc = fstat(mo_descriptor(op->root, slot), s), e = rc < 0 ? errno : 0;
  mo_record(op, stage, "fstat", 0, rc, e, false);
  if (rc < 0) {
    mo_fail(out, "native_io", stage, "status", rc, e);
    return false;
  }
  return true;
}
static bool mo_statat(mo_op *op, int parent, const char *leaf, struct stat *s, const char *stage, mo_result *out) {
  if (!mo_gate(op, out, stage))return false;
  int rc = fstatat(mo_descriptor(op->root, parent), leaf, s, AT_SYMLINK_NOFOLLOW), e = rc < 0 ? errno : 0;
  mo_record(op, stage, "fstatat", AT_SYMLINK_NOFOLLOW, rc, e, false);
  if (rc < 0) {
    mo_fail(out, "native_io", stage, "status", rc, e);
    return false;
  }
  return true;
}
static void mo_close_slot(mo_op *op, int slot, mo_result *out) {
  if (slot < 0)return;
  mo_root *r = op->root;
  int fd;
  const char *stage;
  pthread_mutex_lock(&mo_mutex);
  mo_fd *s = &r->fds[slot];
  if (s->state != FD_OWNED ||(op->serial && s->owner != op)) {
    pthread_mutex_unlock(&mo_mutex);
    return;
  }
  s->state = FD_CLOSING;
  fd = s->fd;
  stage = !s->owner || !strcmp(s->role, "object-directories") ? "directory-close" : "file-close";
  pthread_mutex_unlock(&mo_mutex);
  int e = EIO;
  mo_action action = mo_fault(op, stage, &e);
  int rc;
  if (action == FA_OPEN_ERROR || action == FA_FAIL)rc = -1;
  else {
    rc = close(fd);
    int actual = rc < 0 ? errno : 0;
    if (action == FA_CLOSED_ERROR) {
      rc = -1;
    } else e = actual;
  }
  mo_record(op, stage, "close", 0, rc, e, action != FA_NONE);
  pthread_mutex_lock(&mo_mutex);
  s->state = rc == 0 ? FD_FREE : FD_UNKNOWN;
  if (rc != 0)r->state = ROOT_RETAINED;
  pthread_mutex_unlock(&mo_mutex);
  if (rc != 0)mo_fail(out, "cleanup_unknown", stage, "status", rc, e);
}
static bool mo_sync(mo_op *op, int slot, bool directory, mo_result *out) {
  const char *stage = directory ? "directory-sync" : "file-sync";
  if (!mo_gate(op, out, stage))return false;
  int e = EIO;
  mo_action a = mo_fault(op, stage, &e);
  int rc = -1;
  if (a != FA_FAIL) {
#ifdef __linux__
    rc = fsync(mo_descriptor(op->root, slot));
#else
    rc = fcntl(mo_descriptor(op->root, slot), F_FULLFSYNC);
#endif
    e = rc < 0 ? errno : 0;
  }
  mo_record(op, stage,
#ifdef __linux__
  "fsync",
#else
  "F_FULLFSYNC",
#endif
  0, rc, e, a != FA_NONE);
  if (rc < 0) {
    mo_fail(out, "durability_unavailable", stage, "status", rc, e);
    op->cleanup_pending = true;
  }
  return rc == 0;
}
static bool mo_root_check(mo_op *op, mo_result *out) {
  mo_root *r = op->root;
  for (unsigned i = 0;i < r->dir_count;i++) {
    mo_dir *d = &r->dirs[i];
    struct stat held, path;
    if (!mo_fstat(op, d->slot, &held, "root-check", out))return false;
    if (!mo_same(&held, &d->identity) || !S_ISDIR(held.st_mode) ||(d->private_dir && !mo_private(&held, true))) {
      mo_logic(out, "root_changed", "root-check");
      return false;
    }
    if (d->parent >= 0) {
      if (!mo_statat(op, d->parent, d->leaf, &path, "root-check", out))return false;
      if (!mo_same(&held, &path) || !S_ISDIR(path.st_mode)) {
        mo_logic(out, "root_changed", "root-check");
        return false;
      }
    }
  }
  return true;
}
static bool mo_directory(mo_op *op, int parent, const char *leaf, bool inside, bool private_dir, bool external_ancestor, int *slot, mo_result *out) {
  int flags = O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK;
#ifdef __linux__
  if (external_ancestor)flags = O_PATH|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW;
#else
  (void)external_ancestor;
#endif
  int fd = mo_open(op, parent < 0 ? AT_FDCWD : mo_descriptor(op->root, parent), leaf, flags, 0, inside, "object-directories", out);
  if (fd < 0)return false;
  *slot = fd;
  struct stat s;
  if (!mo_fstat(op, fd, &s, "object-directories", out))return false;
  if (!S_ISDIR(s.st_mode) ||(private_dir && !mo_private(&s, true)) ||(inside && s.st_dev != op->root->device)) {
    mo_logic(out, "root_changed", "object-directories");
    return false;
  }
  pthread_mutex_lock(&mo_mutex);
  op->root->fds[fd].identity = s;
  pthread_mutex_unlock(&mo_mutex);
  if (inside) {
    struct statfs root_fs, child_fs;
    if (!mo_gate(op, out, "object-directories"))return false;
    int rc = fstatfs(mo_descriptor(op->root, op->root->root_dir), &root_fs), e = rc < 0 ? errno : 0;
    mo_record(op, "object-directories", "fstatfs", 0, rc, e, false);
    if (rc < 0) {
      mo_fail(out, "native_io", "object-directories", "status", rc, e);
      return false;
    }
    if (!mo_gate(op, out, "object-directories"))return false;
    rc = fstatfs(mo_descriptor(op->root, fd), &child_fs);
    e = rc < 0 ? errno : 0;
    mo_record(op, "object-directories", "fstatfs", 0, rc, e, false);
    if (rc < 0) {
      mo_fail(out, "native_io", "object-directories", "status", rc, e);
      return false;
    }
    if (memcmp(&root_fs.f_fsid, &child_fs.f_fsid, sizeof(root_fs.f_fsid))) {
      mo_logic(out, "root_changed", "object-directories");
      return false;
    }
  }
  return true;
}
static bool mo_file_identity(mo_op *op, const struct stat *s, mo_result *out, const char *stage) {
  if (!mo_private(s, false) || s->st_dev != op->root->device || s->st_size < 0 ||(uint64_t)s->st_size != op->length) {
    mo_logic(out, "object_integrity", stage);
    return false;
  }
  return true;
}
static bool mo_same_timestamps(const struct stat *a, const struct stat *b) {
#ifdef __linux__
  return a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec && a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
#else
  return a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec && a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
#endif
}
static bool mo_verify_bytes(mo_op *op, int slot, bool fill, mo_result *out, const char *stage) {
  struct stat before, after;
  if (!mo_fstat(op, slot, &before, stage, out) || !mo_file_identity(op, &before, out, stage))return false;
  unsigned char scratch[MO_BLOCK];
  mo_sha hash;
  mo_sha_init(&hash);
  size_t offset = 0;
  while (offset < op->length) {
    if (!mo_gate(op, out, stage))return false;
    size_t want = op->length-offset;
    if (want > MO_BLOCK)want = MO_BLOCK;
    int e = EIO;
    mo_action a = mo_fault(op, "read", &e);
    ssize_t n = -1;
    if (a != FA_FAIL) {
      if ((a == FA_SHORT || a == FA_REPEAT) && want > 1)want = 1;
      n = a == FA_ZERO ? 0 : pread(mo_descriptor(op->root, slot), scratch, want,(off_t)offset);
      e = n < 0 ? errno : 0;
    }
    mo_record(op, stage, "pread", 0, n, e, a != FA_NONE);
    if (n < 0 && e == EINTR)continue;
    if (n < 0) {
      mo_fail(out, "native_io", stage, "bytes", n, e);
      return false;
    }
    if (n == 0) {
      mo_fail(out, "object_integrity", stage, "bytes", 0, 0);
      return false;
    }
    if (fill)memcpy(op->body+offset, scratch,(size_t)n);
    else if (memcmp(op->body+offset, scratch,(size_t)n)) {
      mo_logic(out, "object_integrity", stage);
      return false;
    }
    mo_sha_add(&hash, scratch,(size_t)n);
    offset +=(size_t)n;
  }
  char digest[65];
  mo_sha_end(&hash, digest);
  if (strcmp(digest, op->digest)) {
    mo_logic(out, "object_integrity", stage);
    return false;
  }
  if (!mo_fstat(op, slot, &after, stage, out) || !mo_file_identity(op, &after, out, stage))return false;
  if (!mo_same(&before, &after) || !mo_same_timestamps(&before, &after)) {
    mo_logic(out, "object_integrity", stage);
    return false;
  }
  return true;
}
static bool mo_shard(mo_op *op, bool create, mo_result *out) {
  char name[3] = {
    op->digest[0], op->digest[1], 0
  };
  mo_root *r = op->root;
  if (create) {
    if (!mo_gate(op, out, "object-directories"))return false;
    int rc = mkdirat(mo_descriptor(r, r->sha256), name, 0700), e = rc < 0 ? errno : 0;
    mo_record(op, "object-directories", "mkdirat", 0700, rc, e, false);
    if (rc < 0 && e != EEXIST) {
      mo_fail(out, "native_io", "object-directories", "status", rc, e);
      return false;
    }
    if (rc == 0 && !mo_sync(op, r->sha256, true, out))return false;
  }
  return mo_directory(op, r->sha256, name, true, true, false, &op->shard, out);
}
static bool mo_canonical(mo_op *op, bool fill, mo_result *out) {
  struct stat path, held;
  if (!mo_statat(op, op->shard, op->leaf, &path, "canonical-open", out) || !mo_file_identity(op, &path, out, "canonical-open"))return false;
  op->file = mo_open(op, mo_descriptor(op->root, op->shard), op->leaf, O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK, 0, true, "canonical-open", out);
  if (op->file < 0 || !mo_fstat(op, op->file, &held, "canonical-check", out))return false;
  if (!mo_same(&path, &held)) {
    mo_logic(out, "object_integrity", "canonical-check");
    return false;
  }
  if (!mo_verify_bytes(op, op->file, fill, out, "canonical-check"))return false;
  if (!mo_statat(op, op->shard, op->leaf, &path, "canonical-check", out))return false;
  if (!mo_same(&path, &held) || !mo_file_identity(op, &path, out, "canonical-check")) {
    if (!out->first.code)mo_logic(out, "object_integrity", "canonical-check");
    return false;
  }
  return true;
}
static void mo_unlink_temporary(mo_op *op, mo_result *out) {
  if (!op->temporary_exists || op->cleanup_pending)return;
  if (op->calls >= MO_CALLS || op->expired) {
    op->cleanup_pending = true;
    return;
  }
  struct stat actual;
  if (!mo_statat(op, op->root->staging, op->temporary, &actual, "temporary-unlink", out)) {
    op->cleanup_pending = true;
    return;
  }
  if (!mo_same(&actual, &op->temporary_identity)) {
    mo_logic(out, "root_changed", "temporary-unlink");
    op->cleanup_pending = true;
    return;
  }
  if (!mo_gate(op, out, "temporary-unlink")) {
    op->cleanup_pending = true;
    return;
  }
  int e = EIO;
  mo_action a = mo_fault(op, "temporary-unlink", &e);
  int rc = a == FA_FAIL ? -1 : unlinkat(mo_descriptor(op->root, op->root->staging), op->temporary, 0);
  if (a != FA_FAIL)e = rc < 0 ? errno : 0;
  mo_record(op, "temporary-unlink", "unlinkat", 0, rc, e, a != FA_NONE);
  if (rc < 0) {
    mo_fail(out, "native_io", "temporary-unlink", "status", rc, e);
    op->cleanup_pending = true;
    return;
  }
  op->temporary_exists = false;
  if (!mo_sync(op, op->root->staging, true, out))op->cleanup_pending = true;
}
static bool mo_has_unknown(mo_root *r, void *owner) {
  bool found = false;
  pthread_mutex_lock(&mo_mutex);
  for (int i = 0;i < MO_FDS;i++)if (r->fds[i].state == FD_UNKNOWN &&(!owner || r->fds[i].owner == owner))found = true;
  pthread_mutex_unlock(&mo_mutex);
  return found;
}
static bool mo_retains_op(mo_op *op) {
  bool retained = mo_has_unknown(op->root, op) || op->cleanup_pending || op->temporary_exists;
  if (retained) {
    pthread_mutex_lock(&mo_mutex);
    op->root->state = ROOT_RETAINED;
    pthread_mutex_unlock(&mo_mutex);
  }
  return retained;
}
static void mo_op_cleanup(mo_op *op, mo_result *out) {
  mo_unlink_temporary(op, out);
  for (int i = MO_FDS-1;i >= 0;i--)mo_close_slot(op, i, out);
  if (mo_retains_op(op) &&(op->cleanup_pending || op->temporary_exists || !out->first.code))mo_logic(out, "cleanup_unknown", op->cleanup_pending || op->temporary_exists ? "temporary-unlink" : "file-close");
  pthread_mutex_lock(&mo_mutex);
  op->prepared = false;
  pthread_mutex_unlock(&mo_mutex);
}
static void mo_prepare_native(mo_op *op, mo_result *out) {
  if (!mo_root_check(op, out) || !mo_shard(op, true, out))return;
  unsigned char random[16];
  if (!mo_gate(op, out, "temporary-create"))return;
#ifdef __linux__
  ssize_t random_size = getrandom(random, sizeof(random), 0);
  int random_error = random_size < 0 ? errno : 0;
  mo_record(op, "temporary-create", "getrandom", 0, random_size, random_error, false);
  if (random_size !=(ssize_t)sizeof(random)) {
    mo_fail(out, "native_io", "temporary-create", "bytes", random_size, random_error);
    return;
  }
#else
  arc4random_buf(random, sizeof(random));
  mo_record(op, "temporary-create", "arc4random_buf", 0, 0, 0, false);
#endif
  static const char hex[] = "0123456789abcdef";
  memcpy(op->temporary, "p-", 2);
  for (unsigned i = 0;i < 16;i++) {
    op->temporary[2+i*2] = hex[random[i]>>4];
    op->temporary[3+i*2] = hex[random[i]&15];
  }
  memcpy(op->temporary+34, ".tmp", 5);
  op->writer = mo_open(op, mo_descriptor(op->root, op->root->staging), op->temporary, O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK, 0600, true, "temporary-create", out);
  if (op->writer < 0)return;
  op->temporary_exists = true;
  if (!mo_fstat(op, op->writer, &op->temporary_identity, "temporary-check", out))return;
  if (!mo_private(&op->temporary_identity, false) || op->temporary_identity.st_dev != op->root->device || op->temporary_identity.st_size != 0) {
    mo_logic(out, "object_integrity", "temporary-check");
    return;
  }
  size_t offset = 0;
  while (offset < op->length) {
    if (!mo_gate(op, out, "temporary-write"))return;
    size_t want = op->length-offset;
    if (want > MO_BLOCK)want = MO_BLOCK;
    int e = EIO;
    mo_action a = mo_fault(op, "write", &e);
    ssize_t n = -1;
    if (a != FA_FAIL) {
      if ((a == FA_SHORT || a == FA_REPEAT) && want > 1)want = 1;
      n = a == FA_ZERO ? 0 : pwrite(mo_descriptor(op->root, op->writer), op->body+offset, want,(off_t)offset);
      e = n < 0 ? errno : 0;
    }
    mo_record(op, "temporary-write", "pwrite", 0, n, e, a != FA_NONE);
    if (n < 0 && e == EINTR)continue;
    if (n <= 0) {
      mo_fail(out, "native_io", "temporary-write", "bytes", n, e);
      return;
    }
    offset +=(size_t)n;
  }
  if (!mo_verify_bytes(op, op->writer, false, out, "temporary-check") || !mo_sync(op, op->writer, false, out))return;
  if (!mo_gate(op, out, "publish-noreplace"))return;
  int e = EIO;
  mo_action a = mo_fault(op, "publish-noreplace", &e);
  int rc = -1;
  if (a != FA_FAIL) {
#ifdef __linux__
    rc =(int)syscall(SYS_renameat2, mo_descriptor(op->root, op->root->staging), op->temporary, mo_descriptor(op->root, op->shard), op->leaf, 1u);
#else
    rc = renameatx_np(mo_descriptor(op->root, op->root->staging), op->temporary, mo_descriptor(op->root, op->shard), op->leaf, RENAME_EXCL);
#endif
    e = rc < 0 ? errno : 0;
  }
  mo_record(op, "publish-noreplace", "rename-noreplace", 1, rc, e, a != FA_NONE);
  if (rc < 0 && e != EEXIST) {
    mo_fail(out,(e == ENOSYS || e == ENOTSUP) ? "native_abi_unavailable" : "native_io", "publish-noreplace", "status", rc, e);
    return;
  }
  op->reused = rc < 0;
  if (rc == 0)op->temporary_exists = false;
  if (!mo_canonical(op, false, out))return;
  if (!op->reused) {
    struct stat canonical;
    if (!mo_fstat(op, op->file, &canonical, "canonical-check", out))return;
    if (!mo_same(&canonical, &op->temporary_identity)) {
      mo_logic(out, "object_integrity", "canonical-check");
      return;
    }
  }
  if (!mo_sync(op, op->file, false, out) || !mo_sync(op, op->shard, true, out))return;
  if (op->reused)mo_unlink_temporary(op, out);
  else mo_sync(op, op->root->staging, true, out);
  mo_close_slot(op, op->writer, out);
  if (out->first.code || !mo_root_check(op, out))return;
  pthread_mutex_lock(&mo_mutex);
  op->prepared = true;
  pthread_mutex_unlock(&mo_mutex);
}
static void mo_check_native(mo_op *op, mo_result *out) {
  if (!mo_root_check(op, out) || !mo_verify_bytes(op, op->file, false, out, "prepared-check"))return;
  struct stat path, held;
  if (!mo_statat(op, op->shard, op->leaf, &path, "prepared-check", out) || !mo_fstat(op, op->file, &held, "prepared-check", out))return;
  if (!mo_same(&path, &held) || !mo_file_identity(op, &path, out, "prepared-check")) {
    if (!out->first.code)mo_logic(out, "object_integrity", "prepared-check");
  }
}
static bool mo_unlink_op_locked(mo_op *op) {
  mo_root *r = op->root;
  if (op->refs || op->active || op->pending || r->close_running || r->state == ROOT_CLOSING)return false;
  mo_op **p = &r->operations;
  while (*p && *p != op)p = &(*p)->next;
  if (!*p)return false;
  *p = op->next;
  return true;
}
static void mo_destroy_op(mo_op *op) {
  mo_record(op, "native-complete", "fixture-retire-operation", 0, 0, 0, false);
  free(op->body);
  free(op);
}
static void mo_drop_op_ref(mo_op *op) {
  /* Drop and unlink are one critical section. Cleanup workers hold their own
     reference, so a concurrent wrapper finalizer cannot retire a borrowed op. */
  pthread_mutex_lock(&mo_mutex);
  op->refs--;
  bool release = mo_unlink_op_locked(op);
  pthread_mutex_unlock(&mo_mutex);
  if (release)mo_destroy_op(op);
}
static bool mo_root_close_native(mo_root *r, mo_result *out) {
  mo_op cleanup = {
    .root = r
  };
  clock_gettime(CLOCK_MONOTONIC, &cleanup.started);
  pthread_mutex_lock(&mo_mutex);
  if (r->tasks || r->dispatching || r->acquiring || r->close_running) {
    pthread_mutex_unlock(&mo_mutex);
    return false;
  }
  if (r->state == ROOT_CLOSED) {
    pthread_mutex_unlock(&mo_mutex);
    return true;
  }
  r->close_running = true;
  if (r->state != ROOT_RETAINED)r->state = ROOT_CLOSING;
  pthread_mutex_unlock(&mo_mutex);
  for (mo_op *op = r->operations;op;op = op->next) {
    mo_op_cleanup(op, out);
    bool unknown = mo_retains_op(op);
    pthread_mutex_lock(&mo_mutex);
    if (!unknown)op->pending = false;
    free(op->body);
    op->body = NULL;
    pthread_mutex_unlock(&mo_mutex);
  }
  for (int i = MO_FDS-1;i >= 0;i--)mo_close_slot(&cleanup, i, out);
  bool unknown = mo_has_unknown(r, NULL);
  for (mo_op *op = r->operations;op;op = op->next)if (op->cleanup_pending || op->temporary_exists)unknown = true;
  pthread_mutex_lock(&mo_mutex);
  r->state = unknown ? ROOT_RETAINED : ROOT_CLOSED;
  r->close_running = false;
  mo_op *retired = NULL;
  for (mo_op *op = r->operations, *next;op;op = next) {
    next = op->next;
    if (mo_unlink_op_locked(op)) {
      op->next = retired;
      retired = op;
    }
  }
  pthread_cond_broadcast(&mo_condition);
  pthread_mutex_unlock(&mo_mutex);
  while (retired) {
    mo_op *next = retired->next;
    mo_destroy_op(retired);
    retired = next;
  }
  if (unknown && !out->first.code)mo_logic(out, "cleanup_unknown", "root-close");
  return true;
}
static void mo_auto_close(mo_root *r) {
  pthread_mutex_lock(&mo_mutex);
  bool ready = r->state != ROOT_CLOSED && !r->close_running && !r->wrappers && !r->tasks && !r->acquiring && !r->dispatching && !r->control_tasks;
  for (mo_op *op = r->operations;op;op = op->next)if (op->pending)ready = false;
  if (ready)r->state = ROOT_CLOSING;
  pthread_mutex_unlock(&mo_mutex);
  if (ready) {
    mo_result result = {
      0
    };
    mo_root_close_native(r, &result);
  }
}
/* A caller drops its final C reference atomically with the decision to unlink.
   This prevents two environments from racing a decrement against reclamation. */
static void mo_drop_root_ref(mo_root *r) {
  pthread_mutex_lock(&mo_mutex);
  r->refs--;
  bool release = !r->refs && !r->tasks && !r->dispatching && !r->control_tasks && !r->acquiring && !r->close_running && r->state == ROOT_CLOSED;
  if (release) {
    mo_root **p = &mo_roots;
    while (*p && *p != r)p = &(*p)->next;
    if (*p)*p = r->next;
  }
  pthread_mutex_unlock(&mo_mutex);
  if (!release)return;
  mo_op *op = r->operations;
  while (op) {
    mo_op *next = op->next;
    free(op->body);
    free(op);
    op = next;
  }
#ifdef MO_FIXTURE
  free(r->trace);
#endif
  free(r);
}
static void mo_env_free(mo_env *e) {
  if (e->cleanup_done && !e->refs && !e->jobs)free(e);
}
static void mo_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  mo_wrap *w = data;
  mo_root *r = w->root;
  mo_env *e = w->environment;
  pthread_mutex_lock(&mo_mutex);
  mo_wrap **p = &mo_wrappers;
  while (*p && *p != w)p = &(*p)->next;
  if (*p)*p = w->next;
  p = &e->wrappers;
  while (*p && *p != w)p = &(*p)->env_next;
  if (*p)*p = w->env_next;
  if (w->active && w->kind == WR_ROOT)r->wrappers--;
  bool close_file =(w->kind == WR_FILE || w->kind == WR_HOLD) && w->op->pending && !w->op->active && !r->close_running;
  if (close_file) {
    w->op->active = true;
    r->tasks++;
  }
  w->active = false;
  pthread_mutex_unlock(&mo_mutex);
  if (close_file) {
    mo_result result = {
      0
    };
    mo_op_cleanup(w->op, &result);
    bool unknown = mo_retains_op(w->op);
    pthread_mutex_lock(&mo_mutex);
    if (!unknown)w->op->pending = false;
    w->op->active = false;
    r->tasks--;
    pthread_cond_broadcast(&mo_condition);
    free(w->op->body);
    w->op->body = NULL;
    pthread_mutex_unlock(&mo_mutex);
  }
  mo_auto_close(r);
  pthread_mutex_lock(&mo_mutex);
  e->refs--;
  pthread_mutex_unlock(&mo_mutex);
  if (w->op)mo_drop_op_ref(w->op);
  free(w);
  mo_drop_root_ref(r);
  mo_env_free(e);
}
static napi_value mo_wrap_owner(napi_env env, mo_env *e, mo_root *r, mo_op *op, mo_wrap_kind kind) {
  mo_wrap *w = calloc(1, sizeof(*w));
  if (!w) {
    mo_note(napi_generic_failure);
    return mo_error(env, "resource_unavailable");
  }
  w->root = r;
  w->op = op;
  w->environment = e;
  w->generation = r->generation;
  w->kind = kind;
  w->active = true;
  napi_value value = mo_object(env);
  napi_status status = value ? napi_type_tag_object(env, value, &mo_tags[kind]) : napi_generic_failure;
  if (status == napi_ok)status = napi_wrap(env, value, w, mo_finalize, NULL, NULL);
  if (status != napi_ok) {
    mo_note(status);
    free(w);
    return mo_error(env, "native_abi_unavailable");
  }
  pthread_mutex_lock(&mo_mutex);
  w->next = mo_wrappers;
  mo_wrappers = w;
  w->env_next = e->wrappers;
  e->wrappers = w;
  r->refs++;
  e->refs++;
  if (kind == WR_ROOT)r->wrappers++;
  if (op)op->refs++;
  pthread_mutex_unlock(&mo_mutex);
  return mo_freeze(env, value);
}
static mo_wrap *mo_owner(napi_env env, napi_value value, mo_wrap_kind kind) {
  if (!value)return NULL;
  napi_valuetype type;
  bool tagged = false;
  void *pointer = NULL;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object || napi_check_object_type_tag(env, value, &mo_tags[kind], &tagged) != napi_ok || !tagged || napi_unwrap(env, value, &pointer) != napi_ok)return NULL;
  pthread_mutex_lock(&mo_mutex);
  mo_wrap *w = mo_wrappers;
  while (w && w !=(mo_wrap *)pointer)w = w->next;
  if (w &&(!w->active || w->kind != kind || w->generation != w->root->generation || w->environment->napi != env))w = NULL;
  pthread_mutex_unlock(&mo_mutex);
  return w;
}
static napi_value mo_resources(napi_env env, mo_root *r) {
  if (!r)return mo_null(env);
  unsigned pending = 0, reserved = 0, owned = 0, unknown = 0, prepared = 0;
  size_t bytes = 0;
  unsigned tasks;
  pthread_mutex_lock(&mo_mutex);
  for (int i = 0;i < MO_FDS;i++) {
    reserved += r->fds[i].state == FD_RESERVED;
    owned += r->fds[i].state == FD_OWNED || r->fds[i].state == FD_CLOSING;
    unknown += r->fds[i].state == FD_UNKNOWN;
  }
  for (mo_op *op = r->operations;op;op = op->next) {
    pending += op->pending;
    prepared += op->prepared;
    if (op->body)bytes += op->length;
  }
  tasks = r->tasks+r->control_tasks;
  pthread_mutex_unlock(&mo_mutex);
  napi_value v = mo_object(env);
  mo_set(env, v, "pending", mo_number(env, pending));
  mo_set(env, v, "fdReserved", mo_number(env, reserved));
  mo_set(env, v, "fdOwned", mo_number(env, owned));
  mo_set(env, v, "fdUnknown", mo_number(env, unknown));
  mo_set(env, v, "nativeTasks", mo_number(env, tasks));
  mo_set(env, v, "preparedFiles", mo_number(env, prepared));
  mo_set(env, v, "bodyBytes", mo_number(env,(double)bytes));
  return mo_freeze(env, v);
}
static napi_value mo_fact_value(napi_env env, const mo_fact *f) {
  napi_value v = mo_object(env), call = mo_object(env);
  mo_set(env, v, "code", mo_string(env, f->code));
  mo_set(env, v, "stage", mo_string(env, f->stage));
  mo_set(env, call, "kind", mo_string(env, f->kind));
  bool ran = strcmp(f->kind, "not-run") != 0;
  mo_set(env, call, "rc", ran ? mo_number(env,(double)f->rc) : mo_null(env));
  mo_set(env, call, "errno", ran ? mo_number(env, f->error) : mo_null(env));
  mo_set(env, v, "call", mo_freeze(env, call));
  return mo_freeze(env, v);
}
static napi_value mo_failure(napi_env env, mo_env *e, mo_root *r, const mo_result *result) {
  napi_value v = mo_result_object(env), cleanup = NULL;
  mo_note(napi_create_array_with_length(env, result->count, &cleanup));
  for (unsigned i = 0;i < result->count;i++)mo_index(env, cleanup, i, mo_fact_value(env, &result->cleanup[i]));
  mo_set(env, v, "kind", mo_string(env, "failed"));
  mo_set(env, v, "primary", mo_fact_value(env, &result->first));
  mo_set(env, v, "cleanup", mo_freeze(env, cleanup));
  bool retained = false;
  if (r) {
    pthread_mutex_lock(&mo_mutex);
    retained = r->state == ROOT_RETAINED;
    pthread_mutex_unlock(&mo_mutex);
  }
  mo_set(env, v, "retained", retained ? mo_wrap_owner(env, e, r, NULL, WR_CLEANUP) : mo_null(env));
  mo_set(env, v, "resources", mo_resources(env, r));
  return mo_freeze(env, v);
}
static napi_value mo_immediate(napi_env env, mo_env *e, mo_root *r, const char *code, const char *stage) {
  mo_result result = {
    0
  };
  mo_logic(&result, code, stage);
  napi_deferred deferred;
  napi_value promise;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok)return mo_error(env, "native_abi_unavailable");
  mo_js_frame frame;
  mo_js_begin(&frame);
  napi_value value = mo_failure(env, e, r, &result);
  if (frame.status == napi_ok)mo_note(napi_resolve_deferred(env, deferred, value));
  mo_js_end(&frame);
  if (frame.status != napi_ok) {
    if (r) {
      pthread_mutex_lock(&mo_mutex);
      if (r->state != ROOT_CLOSED)r->state = ROOT_RETAINED;
      pthread_mutex_unlock(&mo_mutex);
    }
    napi_value ignored;
    napi_get_and_clear_last_exception(env, &ignored);
    return mo_error(env, "native_abi_unavailable");
  }
  return promise;
}
static napi_value mo_ref(napi_env env, mo_op *op) {
  napi_value v = mo_object(env);
  mo_set(env, v, "objectFormat", mo_string(env, "utf8-sha256-v1"));
  mo_set(env, v, "storageId", mo_string(env, op->root->storage));
  mo_set(env, v, "contentSha256", mo_string(env, op->digest));
  mo_set(env, v, "byteLength", mo_number(env,(double)op->length));
  return mo_freeze(env, v);
}
static bool mo_scalar_string(napi_env env, napi_value value, char *buffer, size_t capacity, size_t *length) {
  napi_valuetype type;
  size_t size = 0;
  if (!value || napi_typeof(env, value, &type) != napi_ok || type != napi_string || napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok || size >= capacity)return false;
  if (napi_get_value_string_utf8(env, value, buffer, capacity, length) != napi_ok || *length != size || memchr(buffer, 0, size))return false;
  napi_value roundtrip = NULL;
  bool equal = false;
  if (napi_create_string_utf8(env, buffer, size, &roundtrip) != napi_ok || napi_strict_equals(env, value, roundtrip, &equal) != napi_ok || !equal)return false;
  return true;
}
static bool mo_length(napi_env env, napi_value value, size_t maximum, size_t *length) {
  napi_valuetype type;
  double d;
  if (!value || napi_typeof(env, value, &type) != napi_ok || type != napi_number || napi_get_value_double(env, value, &d) != napi_ok || !isfinite(d) || d < 0 ||(d == 0 && signbit(d)) || d >(double)maximum || floor(d) != d)return false;
  *length =(size_t)d;
  return true;
}
typedef struct {
  const char *absolute_root;
  dev_t expected_dev;
  ino_t expected_ino;
  const char *storage_id;
  size_t max_document_bytes;
} mo_root_selection;
static MO_UNUSED napi_value mo_acquire_root(napi_env env, const mo_root_selection *selection) {
  mo_env *e = NULL;
  napi_get_instance_data(env,(void **)&e);
  size_t n = strlen(selection->absolute_root), storage_length = strlen(selection->storage_id);
  if (!mo_self_handle || !e || e->closing)return mo_error(env, "native_abi_unavailable");
  if (!n || n > 4096 || selection->absolute_root[0] != '/' || selection->absolute_root[n-1] == '/' || strstr(selection->absolute_root, "//") || !mo_storage(selection->storage_id, storage_length) || selection->max_document_bytes > MO_MAX)return mo_error(env, "invalid_input");
  char path[4097];
  memcpy(path, selection->absolute_root, n+1);
  unsigned count = 1;
  for (size_t i = 1;i < n;i++)if (path[i] == '/')count++;
  if (count+1 > 32)return mo_error(env, "invalid_input");
  pthread_mutex_lock(&mo_mutex);
  mo_root *r = mo_roots;
  while (r &&(r->device != selection->expected_dev || r->inode != selection->expected_ino || r->state == ROOT_CLOSED))r = r->next;
  if (r) {
    const char *error = r->state == ROOT_OPEN ? NULL : "owner_closing";
    if (strcmp(r->storage, selection->storage_id) || r->maximum != selection->max_document_bytes)error = "invalid_input";
    r->refs++;
    r->acquiring++;
    pthread_mutex_unlock(&mo_mutex);
    mo_op check = {
      .root = r
    };
    clock_gettime(CLOCK_MONOTONIC, &check.started);
    mo_result result = {
      0
    };
    if (!error && !mo_root_check(&check, &result))error = result.first.code;
    /* A selection path is checked independently even when identity groups it with a live root. */
    if (!error && strcmp(r->path, selection->absolute_root)) {
      int parent = -1;
      char *cursor = path+1, *save = NULL;
      int opened[32], used = 0;
      if (mo_directory(&check, -1, "/", false, false, true, &parent, &result))opened[used++] = parent;
      else error = result.first.code;
      for (char *leaf = error ? NULL : strtok_r(cursor, "/", &save);leaf;leaf = strtok_r(NULL, "/", &save)) {
        if (!strcmp(leaf, ".") || !strcmp(leaf, "..")) {
          error = "invalid_input";
          break;
        }
        int next = -1;
        /* The final component is the selected root, even before its private-mode check. */
        bool external_ancestor = save != NULL && *save != '\0';
        if (!mo_directory(&check, parent, leaf, false, false, external_ancestor, &next, &result)) {
          error = result.first.code;
          break;
        }
        opened[used++] = next;
        parent = next;
      }
      struct stat actual;
      if (!error &&(!mo_fstat(&check, parent, &actual, "root-acquire", &result) || actual.st_dev != r->device || actual.st_ino != r->inode || !mo_private(&actual, true)))error = "root_changed";
      for (int i = used-1;i >= 0;i--)mo_close_slot(&check, opened[i], &result);
      if (!error && result.first.code)error = result.first.code;
    }
    napi_value value = error ? mo_error(env, error) : mo_wrap_owner(env, e, r, NULL, WR_ROOT);
    if (!error && !value) {
      pthread_mutex_lock(&mo_mutex);
      r->state = ROOT_RETAINED;
      pthread_mutex_unlock(&mo_mutex);
    }
    pthread_mutex_lock(&mo_mutex);
    r->acquiring--;
    pthread_cond_broadcast(&mo_condition);
    pthread_mutex_unlock(&mo_mutex);
    mo_drop_root_ref(r);
    return value;
  }
  if (mo_generation == UINT64_MAX) {
    pthread_mutex_unlock(&mo_mutex);
    return mo_error(env, "resource_unavailable");
  }
  r = calloc(1, sizeof(*r));
  if (!r) {
    pthread_mutex_unlock(&mo_mutex);
    return mo_error(env, "resource_unavailable");
  }
#ifdef MO_FIXTURE
  r->trace = calloc(8192, sizeof(mo_trace));
  if (!r->trace) {
    free(r);
    pthread_mutex_unlock(&mo_mutex);
    return mo_error(env, "resource_unavailable");
  }
#endif
  r->generation = ++mo_generation;
  r->device = selection->expected_dev;
  r->inode = selection->expected_ino;
  r->maximum = selection->max_document_bytes;
  r->state = ROOT_CLOSING;
  r->refs = 1;
  memcpy(r->storage, selection->storage_id, storage_length+1);
  memcpy(r->path, selection->absolute_root, n+1);
  r->root_dir = r->objects = r->sha256 = r->staging = -1;
  r->next = mo_roots;
  mo_roots = r;
  pthread_mutex_unlock(&mo_mutex);
  mo_op acquire = {
    .root = r
  };
  clock_gettime(CLOCK_MONOTONIC, &acquire.started);
  mo_result result = {
    0
  };
  int parent = -1;
  char *save = NULL;
  if (mo_directory(&acquire, -1, "/", false, false, true, &parent, &result)) {
    r->dirs[r->dir_count++] =(mo_dir) {
      .slot = parent,.parent = -1,.identity = r->fds[parent].identity
    };
    for (char *leaf = strtok_r(path+1, "/", &save);leaf;leaf = strtok_r(NULL, "/", &save)) {
      if (strlen(leaf) > 255 || !strcmp(leaf, ".") || !strcmp(leaf, "..")) {
        mo_logic(&result, "invalid_input", "root-acquire");
        break;
      }
      int next = -1;
      /* Only components before the selected root may use search-only handles. */
      bool external_ancestor = save != NULL && *save != '\0';
      if (!mo_directory(&acquire, parent, leaf, false, false, external_ancestor, &next, &result))break;
      mo_dir *d = &r->dirs[r->dir_count++];
      *d =(mo_dir) {
        .slot = next,.parent = parent,.identity = r->fds[next].identity
      };
      strcpy(d->leaf, leaf);
      parent = next;
    }
  }
  if (!result.first.code) {
    mo_dir *last = &r->dirs[r->dir_count-1];
    last->private_dir = true;
    r->root_dir = last->slot;
    if (last->identity.st_dev != r->device || last->identity.st_ino != r->inode || !mo_private(&last->identity, true))mo_logic(&result, "root_changed", "root-acquire");
  }
  const char *names[] = {
    "objects", "sha256", ".staging"
  };
  for (unsigned i = 0;i < 3 && !result.first.code;i++) {
    int from = i == 0 ? r->root_dir : r->objects, next = -1;
    if (!mo_directory(&acquire, from, names[i], true, true, false, &next, &result))break;
    mo_dir *d = &r->dirs[r->dir_count++];
    *d =(mo_dir) {
      .slot = next,.parent = from,.identity = r->fds[next].identity,.private_dir = true
    };
    strcpy(d->leaf, names[i]);
    if (i == 0)r->objects = next;
    else if (i == 1)r->sha256 = next;
    else r->staging = next;
  }
  if (!result.first.code)mo_root_check(&acquire, &result);
  if (result.first.code) {
    for (int i = MO_FDS-1;i >= 0;i--)mo_close_slot(&acquire, i, &result);
    bool unknown = mo_has_unknown(r, NULL);
    for (mo_op *op = r->operations;op;op = op->next)if (op->cleanup_pending || op->temporary_exists)unknown = true;
    pthread_mutex_lock(&mo_mutex);
    r->state = unknown ? ROOT_RETAINED : ROOT_CLOSED;
    pthread_mutex_unlock(&mo_mutex);
    const char *code = result.first.code;
    mo_drop_root_ref(r);
    return mo_error(env, code);
  }
  pthread_mutex_lock(&mo_mutex);
  for (int i = 0;i < MO_FDS;i++)if (r->fds[i].state == FD_OWNED)r->fds[i].owner = NULL;
  r->state = ROOT_OPEN;
  pthread_mutex_unlock(&mo_mutex);
  napi_value value = mo_wrap_owner(env, e, r, NULL, WR_ROOT);
  if (!value) {
    pthread_mutex_lock(&mo_mutex);
    r->state = ROOT_RETAINED;
    pthread_mutex_unlock(&mo_mutex);
  }
  mo_drop_root_ref(r);
  return value;
}
static bool mo_utf8(const unsigned char *p, size_t n) {
  size_t i = 0;
  while (i < n) {
    uint32_t c = p[i++];
    if (c < 0x80)continue;
    unsigned more;
    uint32_t minimum;
    if (c >= 0xc2 && c <= 0xdf) {
      more = 1;
      c &= 31;
      minimum = 0x80;
    } else if (c >= 0xe0 && c <= 0xef) {
      more = 2;
      c &= 15;
      minimum = 0x800;
    } else if (c >= 0xf0 && c <= 0xf4) {
      more = 3;
      c &= 7;
      minimum = 0x10000;
    } else return false;
    if (n-i < more)return false;
    while (more--) {
      unsigned char b = p[i++];
      if ((b&0xc0) != 0x80)return false;
      c =(c<<6)|(b&63);
    }
    if (c < minimum || c > 0x10ffff ||(c >= 0xd800 && c <= 0xdfff))return false;
  }
  return true;
}
static void mo_execute(napi_env env, void *data) {
  (void)env;
  mo_job *job = data;
  mo_op *op = job->op;
  mo_result *out = &job->result;
  if (job->kind == JOB_CLOSE_ROOT) {
    job->retry = !mo_root_close_native(job->root, out);
    return;
  }
  int e = EIO;
  mo_action a = mo_fault(op, "native-dispatch", &e);
  if (a == FA_FAIL)mo_fail(out, "native_io", "native-dispatch", "status", -1, e);
  pthread_mutex_lock(&mo_mutex);
  bool stopping = job->environment->closing || job->root->state != ROOT_OPEN;
  pthread_mutex_unlock(&mo_mutex);
  if (stopping && !out->first.code && job->kind != JOB_CLOSE_FILE)mo_logic(out, "cancelled", "native-dispatch");
  if (!out->first.code) {
    if (job->kind == JOB_PREPARE)mo_prepare_native(op, out);
    else if (job->kind == JOB_READ) {
      if (mo_root_check(op, out) && mo_shard(op, false, out) && mo_canonical(op, true, out) && mo_root_check(op, out) && !mo_utf8(op->body, op->length))mo_logic(out, "object_integrity", "canonical-check");
    } else if (job->kind == JOB_CHECK)mo_check_native(op, out);
  }
#ifdef MO_FIXTURE
  a = mo_fault(op, "deadline", &e);
  if (a == FA_FAIL) {
    op->expired = true;
    mo_logic(out, "deadline_exceeded", "native-complete");
  }
#endif
  a = mo_fault(op, "native-complete", &e);
  if (a == FA_FAIL)mo_fail(out, "native_io", "native-complete", "status", -1, e);
  if (out->first.code || job->kind == JOB_READ || job->kind == JOB_CLOSE_FILE)mo_op_cleanup(op, out);
}
static void mo_queue_environment_cleanup(mo_env *e);
static bool mo_allocation_failure(mo_op *op, const char *point, const char *allocation);
static bool mo_js_unavailable(napi_env env, napi_status status) {
  if (status == napi_cannot_run_js)return true;
  if (status != napi_pending_exception)return false;
  /* Node 24 reports disabled JS as pending_exception for Node-API < 10.
     A real pending exception remains a delivery failure, never a teardown hint. */
  bool pending = true;
  return napi_is_exception_pending(env, &pending) == napi_ok && !pending;
}
static void mo_complete(napi_env env, napi_status status, void *data) {
  mo_job *job = data;
  mo_env *e = job->environment;
  mo_root *r = job->root;
  mo_op *op = job->op;
  mo_result *out = &job->result;
  napi_value value = NULL;
  if (job->kind == JOB_CLOSE_ROOT &&(job->retry || status == napi_cancelled)) {
    if (job->work) {
      napi_delete_async_work(env, job->work);
      job->work = NULL;
    }
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    bool expired = now.tv_sec-job->started.tv_sec >= 120;
    job->retry = false;
    if (!e->closing && !expired) {
      napi_value name = mo_string(env, "memory-native-mechanical");
      if (name && napi_create_async_work(env, NULL, name, mo_execute, mo_complete, job, &job->work) == napi_ok) {
        if (napi_queue_async_work(env, job->work) == napi_ok)return;
      }
    }
    pthread_mutex_lock(&mo_mutex);
    if (r->state != ROOT_CLOSED)r->state = ROOT_RETAINED;
    pthread_mutex_unlock(&mo_mutex);
    mo_logic(out, expired ? "deadline_exceeded" : e->closing ? "cancelled" : "native_abi_unavailable", "root-close");
  }
  mo_js_frame frame;
  mo_js_begin(&frame);
  if (mo_allocation_failure(op, "native-complete", "fixture-result-allocation"))mo_note(napi_generic_failure);
  if (status == napi_cancelled && !out->first.code) {
    mo_logic(out, "cancelled", "native-dispatch");
    if (op)mo_op_cleanup(op, out);
  }
  if (e->closing && op && op->prepared)mo_op_cleanup(op, out);
  if (!e->closing && !out->first.code && frame.status == napi_ok) {
    value = mo_result_object(env);
    if (job->kind == JOB_PREPARE) {
      mo_set(env, value, "kind", mo_string(env, "prepared-file"));
      mo_set(env, value, "file", mo_wrap_owner(env, e, r, op, WR_FILE));
      mo_set(env, value, "ref", mo_ref(env, op));
      mo_set(env, value, "publication", mo_string(env, op->reused ? "reused" : "created"));
    } else if (job->kind == JOB_READ) {
      napi_value text = NULL;
      mo_note(napi_create_string_utf8(env,(const char *)op->body, op->length, &text));
      mo_set(env, value, "kind", mo_string(env, "read"));
      mo_set(env, value, "markdown", text);
      mo_set(env, value, "ref", mo_ref(env, op));
    } else mo_set(env, value, "kind", mo_string(env, job->kind == JOB_CHECK ? "file-current" : "closed"));
    bool exception = false;
    napi_is_exception_pending(env, &exception);
    if ((exception || !value || frame.status != napi_ok) && !mo_js_unavailable(env, frame.status)) {
      pthread_mutex_lock(&mo_mutex);
      if (r->state != ROOT_CLOSED)r->state = ROOT_RETAINED;
      pthread_mutex_unlock(&mo_mutex);
    }
  }
  bool js_unavailable = e->closing || mo_js_unavailable(env, frame.status);
  if (js_unavailable && op && op->prepared)mo_op_cleanup(op, out);
  bool unknown = op && mo_retains_op(op);
  pthread_mutex_lock(&mo_mutex);
  if (op) {
    op->active = false;
    if (!op->prepared && !unknown)op->pending = false;
    if (!op->prepared) {
      free(op->body);
      op->body = NULL;
    }
    r->tasks--;
  } else r->control_tasks--;
  mo_job **p = &e->work;
  while (*p && *p != job)p = &(*p)->next;
  if (*p)*p = job->next;
  e->jobs--;
  pthread_cond_broadcast(&mo_condition);
  pthread_mutex_unlock(&mo_mutex);
  if (!js_unavailable && frame.status == napi_ok) {
    if (out->first.code)value = mo_failure(env, e, r, out);
    else mo_set(env, value, "resources", mo_resources(env, r));
    if (value && frame.status == napi_ok)mo_note(napi_resolve_deferred(env, job->deferred, mo_freeze(env, value)));
  }
  mo_js_end(&frame);
#ifdef MO_FIXTURE
  if (op && frame.status != napi_ok)mo_record(op, "native-complete", "fixture-napi-status", e->closing ? 1 : 0, frame.status, 0, false);
#endif
  if (frame.status != napi_ok && !e->closing && !mo_js_unavailable(env, frame.status)) {
    pthread_mutex_lock(&mo_mutex);
    if (r->state != ROOT_CLOSED)r->state = ROOT_RETAINED;
    pthread_mutex_unlock(&mo_mutex);
    if (!e->closing) {
      napi_value ignored, fixed = NULL;
      napi_get_and_clear_last_exception(env, &ignored);
      mo_error(env, "native_abi_unavailable");
      if (napi_get_and_clear_last_exception(env, &fixed) == napi_ok && fixed)napi_fatal_exception(env, fixed);
    }
  }
  napi_delete_reference(env, job->owner_ref);
  if (job->work)napi_delete_async_work(env, job->work);
  if (job->promise_ref)napi_delete_reference(env, job->promise_ref);
  if (op)mo_drop_op_ref(op);
  free(job);
  mo_auto_close(r);
  mo_drop_root_ref(r);
  if (e->closing && !e->jobs)mo_queue_environment_cleanup(e);
}
static void mo_environment_cleanup_execute(napi_env env, void *data) {
  (void)env;
  mo_env *e = data;
  for (;;) {
    pthread_mutex_lock(&mo_mutex);
    mo_wrap *w = e->wrappers;
    while (w && !w->active)w = w->env_next;
    if (!w) {
      pthread_mutex_unlock(&mo_mutex);
      break;
    }
    mo_root *r = w->root;
    mo_op *op =(w->kind == WR_FILE || w->kind == WR_HOLD) && !r->close_running ? w->op : NULL;
    w->active = false;
    r->refs++;
    if (w->kind == WR_ROOT)r->wrappers--;
    if (op) {
      op->active = true;
      op->refs++;
      r->tasks++;
    }
    pthread_mutex_unlock(&mo_mutex);
    if (op) {
      mo_result result = {
        0
      };
      mo_op_cleanup(op, &result);
      bool unknown = mo_retains_op(op);
      pthread_mutex_lock(&mo_mutex);
      if (!unknown)op->pending = false;
      op->active = false;
      op->environment = NULL;
      free(op->body);
      op->body = NULL;
      r->tasks--;
      pthread_cond_broadcast(&mo_condition);
      pthread_mutex_unlock(&mo_mutex);
      mo_drop_op_ref(op);
    }
    mo_auto_close(r);
    mo_drop_root_ref(r);
  }
  /* A terminated environment can lose JS delivery before its cleanup hook runs.
     Sweep actual operations as well as wrappers; no JS object is the resource ledger. */
  for (;;) {
    mo_op *orphan = NULL;
    mo_root *r = NULL;
    pthread_mutex_lock(&mo_mutex);
    for (mo_root *candidate = mo_roots;candidate && !orphan;candidate = candidate->next) {
      for (mo_op *op = candidate->operations;op;op = op->next) {
        if (op->environment == e && op->pending && !op->active && !candidate->close_running) {
          orphan = op;
          r = candidate;
          break;
        }
      }
    }
    if (orphan) {
      orphan->active = true;
      orphan->refs++;
      r->tasks++;
      r->refs++;
      orphan->environment = NULL;
    }
    pthread_mutex_unlock(&mo_mutex);
    if (!orphan)break;
    mo_result result = {
      0
    };
    mo_op_cleanup(orphan, &result);
    bool retained = mo_retains_op(orphan);
    pthread_mutex_lock(&mo_mutex);
    if (!retained)orphan->pending = false;
    orphan->active = false;
    free(orphan->body);
    orphan->body = NULL;
    r->tasks--;
    pthread_cond_broadcast(&mo_condition);
    pthread_mutex_unlock(&mo_mutex);
    mo_drop_op_ref(orphan);
    mo_auto_close(r);
    mo_drop_root_ref(r);
  }

}
static void mo_environment_cleanup_complete(napi_env env, napi_status status, void *data) {
  (void)status;
  mo_env *e = data;
  napi_delete_async_work(env, e->cleanup_work);
  pthread_mutex_lock(&mo_mutex);
  for (mo_root *r = mo_roots;r;r = r->next)for (mo_op *op = r->operations;op;op = op->next)if (op->environment == e)op->environment = NULL;
  pthread_mutex_unlock(&mo_mutex);
  e->refs++;
  e->cleanup_done = true;
  napi_remove_async_cleanup_hook(e->hook);
  e->refs--;
  mo_env_free(e);
}
static void mo_queue_environment_cleanup(mo_env *e) {
  if (e->cleanup_queued)return;
  e->cleanup_queued = true;
  if (napi_queue_async_work(e->napi, e->cleanup_work) != napi_ok) {
    /* No operation remains. The preallocated tail can close idle known owners directly. */
    mo_environment_cleanup_execute(e->napi, e);
    mo_environment_cleanup_complete(e->napi, napi_ok, e);
  }
}
static void mo_environment_cleanup(napi_async_cleanup_hook_handle handle, void *data) {
  mo_env *e = data;
  (void)handle;
  pthread_mutex_lock(&mo_mutex);
  e->closing = true;
  for (mo_job *job = e->work;job;job = job->next)if (job->work)napi_cancel_async_work(e->napi, job->work);
  bool ready = e->jobs == 0;
  pthread_mutex_unlock(&mo_mutex);
  if (ready)mo_queue_environment_cleanup(e);
}
static bool mo_allocation_failure(mo_op *op, const char *point, const char *allocation) {
#ifdef MO_FIXTURE
  if (!op)return false;
  bool fail = false;
  int error = EIO;
  mo_root *r = op->root;
  pthread_mutex_lock(&mo_mutex);
  for (unsigned i = 0;i < r->plan_count;i++) {
    mo_plan *p = &r->plans[i];
    if (!strcmp(p->point, point) && p->action == FA_FAIL && ++p->seen == p->occurrence) {
      fail = true;
      error = p->error;
      break;
    }
  }
  pthread_mutex_unlock(&mo_mutex);
  if (fail)mo_record(op, point, allocation, 0, -1, error, true);
  return fail;
#else
  (void)op;
  (void)point;
  (void)allocation;
  return false;
#endif
}
static void mo_abandon(mo_op *op);
static void mo_cancel_dispatch(mo_op *op) {
  pthread_mutex_lock(&mo_mutex);
  if (op->dispatching) {
    op->dispatching = false;
    op->root->dispatching--;
  }
  op->active = false;
  bool new_operation = op->refs == 0;
  bool release = false;
  if (new_operation) {
    op->pending = false;
    free(op->body);
    op->body = NULL;
    release = mo_unlink_op_locked(op);
  }
  pthread_mutex_unlock(&mo_mutex);
  if (release)mo_destroy_op(op);
}
static napi_value mo_queue(napi_env env, mo_env *e, mo_root *r, mo_op *op, mo_job_kind kind, napi_value owner) {
  mo_op dispatch = {
    .root = r
  };
  mo_op *allocation_owner = op ? op : &dispatch;
  mo_job *job = mo_allocation_failure(allocation_owner, "native-dispatch", "fixture-job-allocation") ? NULL : calloc(1, sizeof(*job));
  if (!job) {
    if (op)mo_cancel_dispatch(op);
    else {
      pthread_mutex_lock(&mo_mutex);
      r->close_reserved--;
      if (r->state != ROOT_CLOSED)r->state = ROOT_RETAINED;
      pthread_mutex_unlock(&mo_mutex);
    }
    return mo_immediate(env, e, r, "resource_unavailable", "native-dispatch");
  }
  job->root = r;
  job->op = op;
  job->environment = e;
  job->kind = kind;
  clock_gettime(CLOCK_MONOTONIC, &job->started);
  napi_value promise;
  napi_status promise_status = mo_allocation_failure(allocation_owner, "native-dispatch", "fixture-promise-allocation") ? napi_generic_failure : napi_create_promise(env, &job->deferred, &promise);
  if (promise_status != napi_ok || napi_create_reference(env, owner, 1, &job->owner_ref) != napi_ok ||(kind == JOB_CLOSE_ROOT && napi_create_reference(env, promise, 1, &job->promise_ref) != napi_ok)) {
    if (job->owner_ref)napi_delete_reference(env, job->owner_ref);
    free(job);
    if (op)mo_cancel_dispatch(op);
    pthread_mutex_lock(&mo_mutex);
    if (!op)r->close_reserved--;
    if (r->state != ROOT_CLOSED)r->state = ROOT_RETAINED;
    pthread_mutex_unlock(&mo_mutex);
    return mo_error(env, "native_abi_unavailable");
  }
  pthread_mutex_lock(&mo_mutex);
  r->refs++;
  e->jobs++;
  if (op) {
    r->tasks++;
    op->refs++;
    op->active = true;
  } else {
    r->close_reserved--;
    r->control_tasks++;
  }
  job->next = e->work;
  e->work = job;
  pthread_mutex_unlock(&mo_mutex);
  /* create_async_work may synchronously run async_hooks: no C mutex is held. */
  napi_value name = mo_string(env, "memory-native-mechanical");
  napi_status status = napi_create_async_work(env, NULL, name, mo_execute, mo_complete, job, &job->work);
  pthread_mutex_lock(&mo_mutex);
  if (op && op->dispatching) {
    op->dispatching = false;
    r->dispatching--;
  }
  if (status == napi_ok)status = napi_queue_async_work(env, job->work);
  pthread_mutex_unlock(&mo_mutex);
  if (status != napi_ok) {
    mo_logic(&job->result, "native_abi_unavailable", "native-dispatch");
    if (op)mo_op_cleanup(op, &job->result);
    else {
      pthread_mutex_lock(&mo_mutex);
      if (r->state != ROOT_CLOSED)r->state = ROOT_RETAINED;
      pthread_mutex_unlock(&mo_mutex);
    }
    mo_complete(env, napi_ok, job);
  }
  return promise;
}
static mo_op *mo_new_op(mo_root *r, mo_env *e, const char **error) {
  pthread_mutex_lock(&mo_mutex);
  unsigned pending = 0;
  for (mo_op *op = r->operations;op;op = op->next)pending += op->pending;
  if (r->state != ROOT_OPEN)*error = r->state == ROOT_CLOSED ? "invalid_owner" : "owner_closing";
  else if (pending >= MO_OPS || mo_serial == UINT64_MAX)*error = "resource_unavailable";
  mo_op *op = *error ? NULL : calloc(1, sizeof(*op));
  if (!*error && !op)*error = "resource_unavailable";
  if (op) {
    op->root = r;
    op->environment = e;
    op->pending = true;
    op->dispatching = true;
    r->dispatching++;
    op->serial = ++mo_serial;
    op->file = op->shard = op->writer = -1;
    op->next = r->operations;
    r->operations = op;
    clock_gettime(CLOCK_MONOTONIC, &op->started);
  }
  pthread_mutex_unlock(&mo_mutex);
  return op;
}
static void mo_abandon(mo_op *op) {
  pthread_mutex_lock(&mo_mutex);
  op->pending = false;
  free(op->body);
  op->body = NULL;
  if (op->dispatching) {
    op->dispatching = false;
    op->root->dispatching--;
  }
  bool release = mo_unlink_op_locked(op);
  pthread_mutex_unlock(&mo_mutex);
  if (release)mo_destroy_op(op);
}
static napi_value mo_prepare(napi_env env, napi_callback_info info) {
  napi_value args[2] = {
    NULL, NULL
  };
  size_t argc = 2;
  mo_env *e = NULL;
  napi_get_cb_info(env, info, &argc, args, NULL,(void **)&e);
  mo_wrap *w = mo_owner(env, args[0], WR_ROOT);
  if (!w)return mo_immediate(env, e, NULL, "invalid_owner", "argument");
  const char *error = NULL;
  mo_op *op = mo_new_op(w->root, e, &error);
  if (!op)return mo_immediate(env, e, w->root, error, "reserve-operation");
  napi_valuetype type;
  size_t units = 0, bytes = 0, written = 0;
  if (!args[1] || napi_typeof(env, args[1], &type) != napi_ok || type != napi_string || napi_get_value_string_utf16(env, args[1], NULL, 0, &units) != napi_ok || units > w->root->maximum || napi_get_value_string_utf8(env, args[1], NULL, 0, &bytes) != napi_ok || bytes > w->root->maximum) {
    mo_abandon(op);
    return mo_immediate(env, e, w->root, "invalid_input", "body-copy");
  }
  unsigned char *body = malloc(bytes+1);
  pthread_mutex_lock(&mo_mutex);
  op->body = body;
  op->length = bytes;
  pthread_mutex_unlock(&mo_mutex);
  if (!op->body) {
    mo_abandon(op);
    return mo_immediate(env, e, w->root, "resource_unavailable", "body-copy");
  }
  napi_value roundtrip = NULL;
  bool equal = false;
  if (napi_get_value_string_utf8(env, args[1],(char *)op->body, bytes+1, &written) != napi_ok || written != bytes || napi_create_string_utf8(env,(char *)op->body, bytes, &roundtrip) != napi_ok || napi_strict_equals(env, args[1], roundtrip, &equal) != napi_ok || !equal) {
    mo_abandon(op);
    return mo_immediate(env, e, w->root, "invalid_input", "body-check");
  }
  mo_digest(op->body, bytes, op->digest);
  snprintf(op->leaf, sizeof(op->leaf), "%s.md", op->digest);
  return mo_queue(env, e, w->root, op, JOB_PREPARE, args[0]);
}
static napi_value mo_read(napi_env env, napi_callback_info info) {
  napi_value args[3] = {
    NULL, NULL, NULL
  };
  size_t argc = 3;
  mo_env *e = NULL;
  napi_get_cb_info(env, info, &argc, args, NULL,(void **)&e);
  mo_wrap *w = mo_owner(env, args[0], WR_ROOT);
  if (!w)return mo_immediate(env, e, NULL, "invalid_owner", "argument");
  char digest[65];
  size_t length, bytes;
  if (!mo_scalar_string(env, args[1], digest, sizeof(digest), &length) || !mo_hex(digest, length) || !mo_length(env, args[2], w->root->maximum, &bytes))return mo_immediate(env, e, w->root, "invalid_input", "argument");
  const char *error = NULL;
  mo_op *op = mo_new_op(w->root, e, &error);
  if (!op)return mo_immediate(env, e, w->root, error, "reserve-operation");
  memcpy(op->digest, digest, 65);
  snprintf(op->leaf, sizeof(op->leaf), "%s.md", digest);
  unsigned char *body = malloc(bytes+1);
  pthread_mutex_lock(&mo_mutex);
  op->body = body;
  op->length = bytes;
  pthread_mutex_unlock(&mo_mutex);
  if (!op->body) {
    mo_abandon(op);
    return mo_immediate(env, e, w->root, "resource_unavailable", "body-copy");
  }
  return mo_queue(env, e, w->root, op, JOB_READ, args[0]);
}
static napi_value mo_file_method(napi_env env, napi_callback_info info, bool close_file) {
  napi_value arg = NULL;
  size_t argc = 1;
  mo_env *e = NULL;
  napi_get_cb_info(env, info, &argc, &arg, NULL,(void **)&e);
  mo_wrap *w = mo_owner(env, arg, WR_FILE);
  if (!w)return mo_immediate(env, e, NULL, "invalid_owner", "argument");
  mo_op *op = w->op;
  const char *error = NULL;
  pthread_mutex_lock(&mo_mutex);
  if (w->root->close_running || w->root->state == ROOT_CLOSING)error = "owner_closing";
  else if (op->active || op->dispatching)error = "resource_unavailable";
  else if (!close_file &&(!op->prepared || w->root->state != ROOT_OPEN))error = "invalid_owner";
  if (!error) {
    op->dispatching = true;
    w->root->dispatching++;
    op->active = true;
    op->calls = 0;
    clock_gettime(CLOCK_MONOTONIC, &op->started);
  }
  pthread_mutex_unlock(&mo_mutex);
  if (error)return mo_immediate(env, e, w->root, error, "prepared-check");
  return mo_queue(env, e, w->root, op, close_file ? JOB_CLOSE_FILE : JOB_CHECK, arg);
}
static napi_value mo_check(napi_env env, napi_callback_info info) {
  return mo_file_method(env, info, false);
}
static napi_value mo_close_file(napi_env env, napi_callback_info info) {
  return mo_file_method(env, info, true);
}
static napi_value mo_close_root(napi_env env, napi_callback_info info) {
  napi_value arg = NULL;
  size_t argc = 1;
  mo_env *e = NULL;
  napi_get_cb_info(env, info, &argc, &arg, NULL,(void **)&e);
  mo_wrap *w = mo_owner(env, arg, WR_ROOT);
  if (!w)return mo_immediate(env, e, NULL, "invalid_owner", "argument");
  pthread_mutex_lock(&mo_mutex);
  for (mo_job *existing = e->work;existing;existing = existing->next) {
    if (existing->root == w->root && existing->kind == JOB_CLOSE_ROOT && existing->promise_ref) {
      napi_ref ref = existing->promise_ref;
      pthread_mutex_unlock(&mo_mutex);
      napi_value promise = NULL;
      napi_get_reference_value(env, ref, &promise);
      return promise;
    }
  }
  if (w->root->control_tasks+w->root->close_reserved >= 8) {
    pthread_mutex_unlock(&mo_mutex);
    return mo_immediate(env, e, w->root, "resource_unavailable", "root-close");
  }
  w->root->close_reserved++;
  if (w->root->state == ROOT_OPEN)w->root->state = ROOT_CLOSING;
  for (mo_job *job = e->work;job;job = job->next)if (job->root == w->root && job->kind != JOB_CLOSE_ROOT && job->work)napi_cancel_async_work(env, job->work);
  pthread_mutex_unlock(&mo_mutex);
  return mo_queue(env, e, w->root, NULL, JOB_CLOSE_ROOT, arg);
}
static napi_value mo_observe(napi_env env, napi_callback_info info) {
  napi_value arg = NULL;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  mo_wrap *w = mo_owner(env, arg, WR_ROOT);
  if (!w)return mo_error(env, "invalid_owner");
  const char *names[] = {
    "open", "closing", "retained", "closed"
  };
  pthread_mutex_lock(&mo_mutex);
  mo_root_state state = w->root->state;
  pthread_mutex_unlock(&mo_mutex);
  napi_value v = mo_object(env);
  mo_set(env, v, "state", mo_string(env, names[state]));
  mo_set(env, v, "resources", mo_resources(env, w->root));
  return mo_freeze(env, v);
}
static napi_value mo_abi(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value v = mo_object(env);
  mo_set(env, v, "contract", mo_string(env, "memory-native-mechanical/r1"));
  mo_set(env, v, "napi", mo_number(env, 8));
  mo_set(env, v, "rootFactory", mo_string(env, "not-installed"));
  mo_set(env, v, "pendingLimit", mo_number(env, 8));
  mo_set(env, v, "fdLimit", mo_number(env, 64));
  mo_set(env, v, "bodyLimit", mo_number(env, MO_MAX));
  return mo_freeze(env, v);
}
static napi_value mo_init(napi_env env, napi_value exports) {
  pthread_once(&mo_pin_once, mo_pin_image);
  if (!mo_self_handle)return mo_error(env, "native_abi_unavailable");
  mo_env *e = calloc(1, sizeof(*e));
  if (!e)return mo_error(env, "resource_unavailable");
  e->napi = env;
  napi_value name = mo_string(env, "memory-native-cleanup");
  if (napi_create_async_work(env, NULL, name, mo_environment_cleanup_execute, mo_environment_cleanup_complete, e, &e->cleanup_work) != napi_ok) {
    free(e);
    return mo_error(env, "native_abi_unavailable");
  }
  if (napi_add_async_cleanup_hook(env, mo_environment_cleanup, e, &e->hook) != napi_ok) {
    napi_delete_async_work(env, e->cleanup_work);
    free(e);
    return mo_error(env, "native_abi_unavailable");
  }
  if (napi_set_instance_data(env, e, NULL, NULL) != napi_ok) {
    napi_remove_async_cleanup_hook(e->hook);
    napi_delete_async_work(env, e->cleanup_work);
    free(e);
    return mo_error(env, "native_abi_unavailable");
  }
  const char *names[] = {
    "abiInfo", "prepare", "readVerify", "revalidatePrepared", "closePrepared", "closeRoot", "observeRoot"
  };
  napi_callback methods[] = {
    mo_abi, mo_prepare, mo_read, mo_check, mo_close_file, mo_close_root, mo_observe
  };
  for (unsigned i = 0;i < 7;i++) {
    napi_value fn = NULL;
    if (napi_create_function(env, names[i], NAPI_AUTO_LENGTH, methods[i], e, &fn) != napi_ok)return mo_error(env, "native_abi_unavailable");
    napi_property_descriptor property = {
      .utf8name = names[i],.value = fn,.attributes = napi_writable|napi_enumerable|napi_configurable
    };
    if (napi_define_properties(env, exports, 1, &property) != napi_ok)return mo_error(env, "native_abi_unavailable");
  }
  return exports;
}
#ifndef MO_FIXTURE
NAPI_MODULE(NODE_GYP_MODULE_NAME, mo_init)
#endif
