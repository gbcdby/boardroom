/* #152 G-C1: 原产品 C worker 的独立 TU。未替换 NAPI；未引用的绑定由
 * --gc-sections 丢弃。此有限 C 调用图不是完整 Node/生产 source 资格。 */
#include "../../../native/maintenance-source-files.c"
#include "f4-cfp2-worker.h"
#include <signal.h>
#include <stdarg.h>

#define F4_FRAME_BYTES 65536U
#define F4_TRACE_BYTES (7U * 1024U * 1024U)
#define F4_CHILD_NS UINT64_C(3000000000)
#define F4_PRODUCT_NS UINT64_C(120000000000)
#define F4_PAYLOAD "boardroom F3: one cold ordinary held-FD read; preserved bytes.\n"
#define F4_PROFILE "whole-brd-f4-cfp2-clean-regular-v1"

typedef struct {
  source_owner owner;
  const char *role;
  bool opened;
} f4_slot;
typedef struct {
  char name[96]; unsigned char *bytes; size_t length; unsigned reads;
} f4_saved_fact;
typedef struct {
  const char *run_id, *uuid, *scope, *root;
  uint64_t device, started, seq;
  size_t emitted;
  int first_error, cleanup_error;
  unsigned opens, syncs, closes, transfers, reads, eofs, aux_opens, aux_closes;
  size_t payload_bytes;
  bool full, write_failed;
  size_t context_bytes; unsigned context_calls, unknown_aux;
  f4_saved_fact saved[192]; size_t saved_count;
  f4_slot dp, r, v, f, m;
} f4_state;
static volatile sig_atomic_t f4_cancelled;
static void f4_cancel(int signal_number) { f4_cancelled = signal_number; }
static uint64_t f4_now(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) return 0;
  return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
}
static bool f4_error(f4_state *s, int error) {
  if (!s->first_error) s->first_error = error ? error : EIO;
  return false;
}
static bool f4_charge(f4_state *s) {
  const uint64_t now = f4_now();
  if (f4_cancelled) return f4_error(s, ECANCELED);
  if (!now || now < s->started || now - s->started >= F4_CHILD_NS ||
      now - s->started >= F4_PRODUCT_NS) return f4_error(s, ETIMEDOUT);
  return !s->first_error;
}
static bool f4_emit(f4_state *s, const char *event, const char *role, int fd,
                    int rc, int error, const char *format, ...) {
  char data[F4_FRAME_BYTES], line[F4_FRAME_BYTES];
  va_list args; va_start(args, format);
  int n = vsnprintf(data, sizeof(data), format, args); va_end(args);
  if (n < 0 || (size_t)n >= sizeof(data)) return f4_error(s, EOVERFLOW);
  const uint64_t now = f4_now();
  n = snprintf(line, sizeof(line), "BRDCF4 {\"v\":1,\"run_id\":\"%s\",\"pid\":%ld,\"seq\":%llu,"
    "\"ns\":\"%llu\",\"event\":\"%s\",\"role\":\"%s\",\"fd\":%d,\"rc\":%d,\"errno\":%d,\"data\":%s}\n",
    s->run_id, (long)getpid(), (unsigned long long)++s->seq, (unsigned long long)now,
    event, role, fd, rc, error, data);
  if (n < 0 || (size_t)n >= sizeof(line) || s->emitted > F4_TRACE_BYTES - (size_t)n)
    return f4_error(s, EOVERFLOW);
  size_t at = 0;
  while (at < (size_t)n) {
    ssize_t written = write(STDOUT_FILENO, line + at, (size_t)n - at);
    if (written <= 0) { s->write_failed = true; return f4_error(s, written ? errno : EIO); }
    at += (size_t)written;
  }
  s->emitted += (size_t)n;
  return true;
}
static void f4_hex(const void *data, size_t length, char *out) {
  static const char digits[] = "0123456789abcdef";
  const unsigned char *bytes = data;
  for (size_t i = 0; i < length; i++) { out[i * 2] = digits[bytes[i] >> 4]; out[i * 2 + 1] = digits[bytes[i] & 15]; }
  out[length * 2] = 0;
}
static void f4_slot_init(f4_slot *slot, const char *role) {
  memset(slot, 0, sizeof(*slot)); slot->role = role;
  slot->owner.fd = slot->owner.parent_fd = -1;
}
static bool f4_metadata_fd(f4_state *s,const char *role,int fd,bool directory,
                          const struct stat *initial,uint64_t expected_legacy,uint64_t expected_unique,const char *stage) {
  if (!f4_charge(s)) return false;
  struct stat current;struct statfs fs; uint64_t legacy = 0, unique = 0;
  errno = 0; int rc = fstat(fd, &current), error = rc ? errno : 0;
  if(!rc){rc=fstatfs(fd,&fs);error=rc?errno:0;}
  if (!rc && (!valid_metadata(&current, directory) ||
      !same_metadata(&current, initial) || (s->full && fs.f_type!=EXT4_SUPER_MAGIC) ||
      !mount_pair(fd, &current, &legacy, &unique) ||
      legacy != expected_legacy || unique != expected_unique)) {
    rc = -1; error = errno ? errno : ESTALE;
  }
  if (rc) {
    f4_emit(s, "metadata", role, fd, rc, error, "{\"stage\":\"%s\"}", stage);
    return f4_error(s, error);
  }
  if (!f4_emit(s, "metadata", role, fd, 0, 0,
    "{\"stage\":\"%s\",\"dev\":%llu,\"ino\":%llu,\"mode\":%u,\"uid\":%u,\"gid\":%u,"
    "\"nlink\":%llu,\"size\":%lld,\"fs_type\":%lld,\"atime_ns\":\"%lld\",\"mtime_ns\":\"%lld\",\"ctime_ns\":\"%lld\","
    "\"mount_id\":%llu,\"mount_unique\":%llu}", stage,
    (unsigned long long)current.st_dev, (unsigned long long)current.st_ino, current.st_mode, current.st_uid,
    current.st_gid, (unsigned long long)current.st_nlink, (long long)current.st_size,(long long)fs.f_type,
    (long long)current.st_atim.tv_sec * 1000000000LL + current.st_atim.tv_nsec,
    (long long)current.st_mtim.tv_sec * 1000000000LL + current.st_mtim.tv_nsec,
    (long long)current.st_ctim.tv_sec * 1000000000LL + current.st_ctim.tv_nsec,
    (unsigned long long)legacy, (unsigned long long)unique)) return false;
  return f4_charge(s);
}
static bool f4_metadata(f4_state *s, f4_slot *slot, const char *stage) {
  return f4_metadata_fd(s,slot->role,slot->owner.fd,slot->owner.directory,&slot->owner.initial,
                        slot->owner.legacy_mount_id,slot->owner.unique_mount_id,stage);
}
static bool f4_open(f4_state *s, f4_slot *slot, int parent, const char *name, bool directory, bool metadata) {
  if (!f4_charge(s) || slot->opened) return f4_error(s, EINVAL);
  if (parent != AT_FDCWD) {
    struct stat held;
    if (fstat(parent,&held) || !same_metadata(&held,&s->dp.owner.initial)) return f4_error(s,errno?errno:ESTALE);
  }
  slot->owner.directory = directory; slot->owner.metadata_only = metadata;
  errno = 0;
  if (metadata) {
    struct open_how how = {.flags=O_PATH | O_CLOEXEC | O_NOFOLLOW,
      .resolve=RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV};
    slot->owner.fd = (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
  } else slot->owner.fd = strict_openat(parent, name, directory, parent == AT_FDCWD);
  int error = slot->owner.fd < 0 ? errno : 0;
  if (slot->owner.fd >= 0) { slot->opened = true; s->opens++; }
  int flags=slot->owner.fd<0?-1:fcntl(slot->owner.fd,F_GETFL);
  int fd_flags=slot->owner.fd<0?-1:fcntl(slot->owner.fd,F_GETFD);
  if(slot->owner.fd>=0 && (flags<0 || fd_flags!=FD_CLOEXEC)) error=errno?errno:EIO;
  f4_emit(s, "open", slot->role, slot->owner.fd, slot->owner.fd < 0 ? -1 : 0, error,
    "{\"parent_fd\":%d,\"metadata_only\":%s,\"directory\":%s,\"flags\":%d,\"fd_flags\":%d}", parent,
    metadata ? "true" : "false", directory ? "true" : "false",flags,fd_flags);
  if (error) return f4_error(s, error);
  if (fstat(slot->owner.fd, &slot->owner.initial) || !valid_metadata(&slot->owner.initial, directory) ||
      !mount_pair(slot->owner.fd, &slot->owner.initial, &slot->owner.legacy_mount_id, &slot->owner.unique_mount_id))
    return f4_error(s, errno ? errno : ESTALE);
  if(s->full && slot==&s->dp && (slot->owner.initial.st_ino!=2 || slot->owner.initial.st_uid!=1000 ||
      slot->owner.initial.st_gid!=1000 || slot->owner.initial.st_mode!=(S_IFDIR|0700))) return f4_error(s,ESTALE);
  if(s->full && slot!=&s->dp && (slot->owner.initial.st_gid!=1000 ||
      slot->owner.initial.st_mode!=(S_IFREG|0600) || slot->owner.initial.st_size!=(off_t)(sizeof(F4_PAYLOAD)-1)))
    return f4_error(s,ESTALE);
  if (s->device && slot->owner.initial.st_dev != s->device) return f4_error(s, EXDEV);
  if (!s->device) s->device = slot->owner.initial.st_dev;
  if (slot != &s->dp && (slot->owner.legacy_mount_id != s->dp.owner.legacy_mount_id ||
      slot->owner.unique_mount_id != s->dp.owner.unique_mount_id)) return f4_error(s, EXDEV);
  if (slot != &s->dp && slot != &s->m && !same_metadata(&slot->owner.initial, &s->m.owner.initial))
    return f4_error(s, ESTALE);
  if (parent != AT_FDCWD) {
    struct stat path,held;
    if (fstatat(parent,name,&path,AT_SYMLINK_NOFOLLOW) || fstat(parent,&held) ||
        !same_metadata(&path,&slot->owner.initial) || !same_metadata(&held,&s->dp.owner.initial))
      return f4_error(s,errno?errno:ESTALE);
  }
  return f4_metadata(s, slot, "opened");
}
static bool f4_sync(f4_state *s, f4_slot *slot) {
  if (!f4_charge(s) || slot->owner.fd < 0 || slot->owner.metadata_only) return f4_error(s, EINVAL);
  source_work work = {.owner=&slot->owner};
  s->syncs++; source_work_execute(NULL, &work);
  f4_emit(s, "sync", slot->role, slot->owner.fd, work.source_rc, work.source_error,
    "{\"ran\":%s}", work.source_ran ? "true" : "false");
  if (work.error || !work.source_ran) return f4_error(s, work.error);
  return f4_metadata(s, slot, "after-sync");
}
static bool f4_close(f4_state *s, f4_slot *slot) {
  if (slot->owner.fd < 0 && slot->owner.parent_fd < 0) return true;
  const int fd = slot->owner.fd, parent = slot->owner.parent_fd;
  source_work work = {.owner=&slot->owner,.closing=true};
  source_work_execute(NULL, &work);
  if (slot->owner.tail && work.parent_ran) {
    s->closes++; f4_emit(s, "close", "A", parent, work.parent_rc, work.parent_error, "{\"ran\":true}");
  }
  if (work.source_ran) {
    s->closes++; f4_emit(s, "close", slot->role, fd, work.source_rc, work.source_error, "{\"ran\":true}");
  }
  if (work.error) {
    if (!s->cleanup_error) s->cleanup_error = work.error;
    return f4_error(s, work.error);
  }
  return true;
}
static bool f4_payload(f4_state *s) {
  unsigned char data[256]; size_t total = 0;
  while (true) {
    if (!f4_metadata(s, &s->r, "before-read")) return false;
    errno = 0; ssize_t count = read(s->r.owner.fd, data, sizeof(data)); int error = count < 0 ? errno : 0;
    s->reads++;
    if (count < 0) {
      f4_emit(s, "payload", "R", s->r.owner.fd, -1, error, "{\"offset\":%zu,\"hex\":\"\"}", total);
      return f4_error(s, error);
    }
    if (!count) { s->eofs++; f4_emit(s, "payload-eof", "R", s->r.owner.fd, 0, 0, "{\"offset\":%zu}", total); break; }
    char hex[sizeof(data) * 2 + 1]; f4_hex(data, (size_t)count, hex);
    s->payload_bytes += (size_t)count;
    f4_emit(s, "payload", "R", s->r.owner.fd, (int)count, 0, "{\"offset\":%zu,\"hex\":\"%s\"}", total, hex);
    if (total + (size_t)count > sizeof(F4_PAYLOAD) - 1 || memcmp(F4_PAYLOAD + total, data, (size_t)count))
      return f4_error(s, ESTALE);
    total += (size_t)count;
    if (!f4_metadata(s, &s->r, "after-read")) return false;
  }
  if (total != sizeof(F4_PAYLOAD) - 1 || !f4_metadata(s, &s->r, "after-eof")) return f4_error(s, ESTALE);
  const off_t ro = lseek(s->r.owner.fd, 0, SEEK_CUR), vo = lseek(s->v.owner.fd, 0, SEEK_CUR);
  f4_emit(s, "offsets", "R", s->r.owner.fd, ro < 0 || vo < 0 ? -1 : 0, ro < 0 || vo < 0 ? errno : 0,
    "{\"R\":%lld,\"V\":%lld}", (long long)ro, (long long)vo);
  return ro == (off_t)total && vo == 0 ? f4_charge(s) : f4_error(s, ESTALE);
}
/* 完整 guest 观察由同 TU 下方有限 collector 提供；纯普通文件控制不伪造这些事实。 */
static bool f4_environment(f4_state *s, const char *stage, int source, int carrier);
static bool f4_extended(f4_state *s, f4_slot *slot, const char *stage);
static bool f4_directory(f4_state *s, const char *stage);

static int f4_execute(f4_state *s) {
  f4_slot_init(&s->dp,"Dp"); f4_slot_init(&s->r,"R"); f4_slot_init(&s->v,"V");
  f4_slot_init(&s->f,"F"); f4_slot_init(&s->m,"M");
  s->started = f4_now(); f4_cancelled = 0;
  struct sigaction action = {.sa_handler=f4_cancel}; sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM,&action,NULL) || sigaction(SIGINT,&action,NULL)) return 1;
  signal(SIGPIPE,SIG_IGN);
  f4_emit(s,"begin","-",-1,0,0,"{\"profile\":\"%s\",\"scope\":\"%s\",\"D0_ns\":\"%llu\","
    "\"product_budget_ns\":\"%llu\",\"child_budget_ns\":\"%llu\",\"uuid\":\"%s\"}",
    F4_PROFILE,s->scope,(unsigned long long)s->started,(unsigned long long)F4_PRODUCT_NS,
    (unsigned long long)F4_CHILD_NS,s->uuid);
  if (!f4_open(s,&s->dp,AT_FDCWD,s->root,true,false) ||
      !f4_open(s,&s->m,s->dp.owner.fd,"payload",false,true)) goto cleanup;
  if (s->full && (!f4_environment(s,"before",s->m.owner.fd,s->dp.owner.fd) ||
      !f4_extended(s,&s->dp,"before") || !f4_directory(s,"before"))) goto cleanup;
  if (!f4_open(s,&s->r,s->dp.owner.fd,"payload",false,false) ||
      !f4_open(s,&s->v,s->dp.owner.fd,"payload",false,false)) goto cleanup;
  if (s->full && (!f4_extended(s,&s->r,"before") || !f4_extended(s,&s->v,"before"))) goto cleanup;
#if defined(F4_CFP2_OWNER_CONTROL) && defined(F4_CFP2_TEST_CANCEL)
  raise(SIGTERM);
#endif
  if (!f4_sync(s,&s->r) || !f4_payload(s) ||
      !f4_open(s,&s->f,s->dp.owner.fd,"payload",false,false)) goto cleanup;
  if (s->full && !f4_extended(s,&s->f,"reopen")) goto cleanup;
  if (!f4_close(s,&s->f)) goto cleanup;
  if (s->full && !f4_extended(s,&s->r,"after")) goto cleanup;
  if (!f4_metadata(s,&s->r,"before-close") || !f4_close(s,&s->r) ||
      !f4_sync(s,&s->v)) goto cleanup;
  if (s->full && (!f4_extended(s,&s->v,"after") || !f4_environment(s,"after-v",s->v.owner.fd,s->dp.owner.fd))) goto cleanup;
  if (!f4_close(s,&s->v) || !f4_metadata(s,&s->dp,"before-sync")) goto cleanup;
  if (s->full && !f4_directory(s,"after")) goto cleanup;
  if (!f4_sync(s,&s->dp)) goto cleanup;
  s->m.owner.parent_fd=s->dp.owner.fd; s->m.owner.parent_initial=s->dp.owner.initial;
  s->m.owner.tail=true; s->dp.owner.fd=-1; s->dp.owner.invalid=true; s->transfers++;
  f4_emit(s,"transfer","A",s->m.owner.parent_fd,0,0,"{\"from\":\"Dp\",\"old_owner_live\":false,\"dup\":false}");
  if (!f4_metadata(s,&s->m,"tail")) goto cleanup;
  if (s->full && !f4_environment(s,"tail",s->m.owner.fd,s->m.owner.parent_fd)) goto cleanup;
  if (!f4_charge(s)) goto cleanup;
#if defined(F4_CFP2_OWNER_CONTROL) && defined(F4_CFP2_TEST_TAIL_A_EBADF)
  /* 测试专属：实际提前关闭自有 A，随后原 worker 真实得到 EBADF；没有
   * fake errno/close wrapper，且中间不打开资源。公共 target 无此分支。 */
  { errno=0;int rc=close(s->m.owner.parent_fd),error=rc?errno:0;
    f4_emit(s,"control-close-a","A",s->m.owner.parent_fd,rc,error,"{}"); }
#endif
  f4_close(s,&s->m);
cleanup:
  f4_close(s,&s->f); f4_close(s,&s->r); f4_close(s,&s->v); f4_close(s,&s->dp); f4_close(s,&s->m);
  /* 数字未知 FD 不重试；原 worker 的 unknown 位是完成判定的一部分。 */
  f4_slot *slots[]={&s->dp,&s->r,&s->v,&s->f,&s->m}; unsigned live=0,unknown=0;
  for (size_t i=0;i<sizeof(slots)/sizeof(slots[0]);i++) {
    source_owner *o=&slots[i]->owner;
    live+=(o->fd>=0)+(o->parent_fd>=0); unknown+=o->close_unknown+o->parent_close_unknown;
  }
  unknown+=s->unknown_aux;
  if (live || unknown || s->aux_opens!=s->aux_closes) f4_error(s,EIO);
  for (size_t i=0;i<s->saved_count;i++) free(s->saved[i].bytes);
  f4_charge(s);
  f4_emit(s,"complete","-",-1,s->first_error ? -1 : 0,s->first_error,
    "{\"scope\":\"%s\",\"first_errno\":%d,\"cleanup_errno\":%d,\"unknown_closes\":%u,\"live_owners\":%u,"
    "\"opens\":%u,\"syncs\":%u,\"closes\":%u,\"transfers\":%u,\"reads\":%u,\"payload_bytes\":%zu,"
    "\"eofs\":%u,\"aux_opens\":%u,\"aux_closes\":%u}",s->scope,s->first_error,s->cleanup_error,
    unknown,live,s->opens,s->syncs,s->closes,s->transfers,s->reads,s->payload_bytes,s->eofs,s->aux_opens,s->aux_closes);
  return s->first_error || s->write_failed ? 1 : 0;
}

#ifdef F4_CFP2_OWNER_CONTROL
#ifndef F4_CFP2_TEST_ROOT
#error "ordinary file control requires a fixed owned temporary root at compile time"
#endif
static bool f4_environment(f4_state *s,const char *stage,int source,int carrier) {
  (void)stage;(void)source;(void)carrier;return f4_error(s,ENOTSUP);
}
static bool f4_extended(f4_state *s,f4_slot *slot,const char *stage) {
  (void)slot;(void)stage;return f4_error(s,ENOTSUP);
}
static bool f4_directory(f4_state *s,const char *stage) { (void)stage;return f4_error(s,ENOTSUP); }
int f4_cfp2_owner_control(void) {
  f4_state state={.run_id="358af363-b224-4d47-a5b6-5a4573192db3",.uuid="control-only",
    .scope="owned-file-control",.root=F4_CFP2_TEST_ROOT};
  return f4_execute(&state);
}
#else
#include "f4-cfp2-observe.h"
/* 公共 guest target 不接受临时路径或 control bypass。 */
int f4_cfp2_run(const char *run_id,const char *filesystem_uuid) {
  if (!run_id || !filesystem_uuid || strlen(run_id)!=36 || strlen(filesystem_uuid)!=36) return 64;
  for (size_t i=0;i<36;i++) {
    const bool dash=i==8 || i==13 || i==18 || i==23;
    const char a=run_id[i],b=filesystem_uuid[i];
    if (dash ? (a!='-' || b!='-') :
        (!((a>='0'&&a<='9')||(a>='a'&&a<='f')) || !((b>='0'&&b<='9')||(b>='a'&&b<='f')))) return 64;
  }
  f4_state state={.run_id=run_id,.uuid=filesystem_uuid,.scope="clean-regular-native",
    .root="/mnt/brd",.full=true};
  return f4_execute(&state);
}
#endif
