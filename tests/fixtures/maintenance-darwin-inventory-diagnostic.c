/* Test-only tracing of the unchanged native inventory. Never used by the adapter. */
#include <sys/types.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define DIAGNOSTIC_MAX_RANGE_PROBES 8

static unsigned int diagnostic_events;
static unsigned int diagnostic_range_probes;
static bool diagnostic_event(const char *api) {
  if (diagnostic_events++ < 4096) {
    fprintf(stderr, "{\"api\":\"%s\"", api);
    return true;
  }
  if (diagnostic_events == 4097) fputs("{\"diagnosticTruncated\":true,\"limit\":4096}\n", stderr);
  return false;
}

static void diagnostic_region_fields(const struct proc_regioninfo *region) {
  fprintf(stderr, ",\"mappingBegin\":\"%" PRIu64 "\",\"mappingSize\":\"%" PRIu64 "\",\"mappingOffset\":\"%" PRIu64 "\",\"flags\":%u,\"protection\":%u,\"maxProtection\":%u,\"userTag\":%u,\"shareMode\":%u,\"depth\":%u,\"regionBytesHex\":\"",
    (uint64_t)region->pri_address, (uint64_t)region->pri_size, (uint64_t)region->pri_offset,
    (unsigned int)region->pri_flags, (unsigned int)region->pri_protection, (unsigned int)region->pri_max_protection,
    (unsigned int)region->pri_user_tag, (unsigned int)region->pri_share_mode, (unsigned int)region->pri_depth);
  const unsigned char *bytes = (const unsigned char *)region;
  for (size_t i = 0; i < sizeof(*region) && i < 256; i++) fprintf(stderr, "%02x", (unsigned int)bytes[i]);
  fputc('"', stderr);
}

static void diagnostic_vnode_fields(const struct vnode_info_path *vnode) {
  /* Only vnode identity and path presence, never another process's mapped file contents. */
  fprintf(stderr, ",\"vnodeDevice\":\"%" PRIu32 "\",\"vnodeInode\":\"%" PRIu64 "\",\"vnodeLinks\":%u,\"vnodePathPresent\":%s",
    vnode->vip_vi.vi_stat.vst_dev, vnode->vip_vi.vi_stat.vst_ino, (unsigned int)vnode->vip_vi.vi_stat.vst_nlink,
    vnode->vip_path[0] ? "true" : "false");
}

static void diagnostic_layout(void) {
  static bool recorded;
  if (recorded) return;
  recorded = true;
  if (diagnostic_event("compiled-layout")) fprintf(stderr,
    ",\"regionInfoBytes\":%zu,\"regionWithPathBytes\":%zu,\"addressOffset\":%zu,\"sizeOffset\":%zu,\"vnodeOffset\":%zu,\"maxRangeProbeGroups\":%d,\"queriesPerGroup\":4}\n",
    sizeof(struct proc_regioninfo), sizeof(struct proc_regionwithpathinfo), offsetof(struct proc_regioninfo, pri_address),
    offsetof(struct proc_regioninfo, pri_size), offsetof(struct proc_regionwithpathinfo, prp_vip), DIAGNOSTIC_MAX_RANGE_PROBES);
}

static void diagnostic_range_probe(int pid, int flavor, uint64_t address, unsigned int group, const char *position) {
  struct proc_regionwithpathinfo with_path;
  struct proc_regioninfo region;
  const bool path_info = flavor == PROC_PIDREGIONPATHINFO;
  void *buffer = path_info ? (void *)&with_path : (void *)&region;
  int size = (int)(path_info ? sizeof(with_path) : sizeof(region));
  memset(buffer, 0, (size_t)size); errno = 0;
  /* Calls precede the macros below: real libproc, distinct buffers, no recursion or production retry. */
  const int result = proc_pidinfo(pid, flavor, address, buffer, size);
  const int observed_errno = errno;
  if (diagnostic_event("range-probe")) {
    fprintf(stderr, ",\"observation\":\"subsequent-call\",\"probeGroup\":%u,\"position\":\"%s\",\"pid\":%d,\"flavor\":%d,\"argument\":\"%" PRIu64 "\",\"returnedBytes\":%d,\"requestedBytes\":%d,\"errno\":%d",
      group, position, pid, flavor, address, result, size, observed_errno);
    if (result == size) {
      diagnostic_region_fields(path_info ? &with_path.prp_prinfo : &region);
      if (path_info) diagnostic_vnode_fields(&with_path.prp_vip);
    }
    fputs("}\n", stderr);
  }
}

static int diagnostic_pidinfo(int pid, int flavor, uint64_t argument, void *buffer, int size) {
  const int result = proc_pidinfo(pid, flavor, argument, buffer, size);
  const int saved_errno = errno;
  diagnostic_layout();
  const bool identity = flavor == PROC_PIDTBSDINFO && result == (int)sizeof(struct proc_bsdinfo);
  const bool region = flavor == PROC_PIDREGIONPATHINFO && result == (int)sizeof(struct proc_regionwithpathinfo);
  const struct proc_regionwithpathinfo *mapping = region ? buffer : NULL;
  const bool invalid_range = mapping && (mapping->prp_prinfo.pri_size == 0
    || mapping->prp_prinfo.pri_address > UINT64_MAX - mapping->prp_prinfo.pri_size
    || mapping->prp_prinfo.pri_address + mapping->prp_prinfo.pri_size <= argument);
  const unsigned int probe_group = invalid_range && diagnostic_range_probes < DIAGNOSTIC_MAX_RANGE_PROBES
    ? ++diagnostic_range_probes : 0;
  /* Successful ordinary regions can be numerous. Keep terminal/error calls and range failures. */
  if ((flavor != PROC_PIDREGIONPATHINFO || !region || invalid_range) && diagnostic_event("proc_pidinfo")) {
    const char *name = flavor == PROC_PIDTBSDINFO ? "PROC_PIDTBSDINFO"
      : flavor == PROC_PIDLISTFDS ? "PROC_PIDLISTFDS" : "PROC_PIDREGIONPATHINFO";
    fprintf(stderr, ",\"observation\":\"inventory-call\",\"pid\":%d,\"flavor\":%d,\"flavorName\":\"%s\",\"argument\":\"%" PRIu64 "\",\"returnedBytes\":%d,\"requestedBytes\":%d,\"errno\":%d",
      pid, flavor, name, argument, result, size, saved_errno);
    if (identity) {
      const struct proc_bsdinfo *process = buffer;
      fprintf(stderr, ",\"identityPid\":%u,\"uid\":%u,\"startSeconds\":\"%" PRIu64 "\",\"startMicroseconds\":\"%" PRIu64 "\"",
        (unsigned int)process->pbi_pid, (unsigned int)process->pbi_uid, process->pbi_start_tvsec, process->pbi_start_tvusec);
    }
    if (mapping) {
      diagnostic_region_fields(&mapping->prp_prinfo); diagnostic_vnode_fields(&mapping->prp_vip);
      fprintf(stderr, ",\"extraProbeGroup\":%u", probe_group);
    }
    fputs("}\n", stderr);
  }
  if (probe_group) {
    const uint64_t begin = mapping->prp_prinfo.pri_address;
    diagnostic_range_probe(pid, PROC_PIDREGIONPATHINFO, argument, probe_group, "original-query");
    diagnostic_range_probe(pid, PROC_PIDREGIONPATHINFO, begin, probe_group, "returned-begin");
    diagnostic_range_probe(pid, PROC_PIDREGIONINFO, argument, probe_group, "original-query");
    diagnostic_range_probe(pid, PROC_PIDREGIONINFO, begin, probe_group, "returned-begin");
  }
  /* Neither an extra query nor diagnostic output changes the original result, buffer or errno. */
  errno = saved_errno;
  return result;
}

static int diagnostic_pidfdinfo(int pid, int fd, int flavor, void *buffer, int size) {
  const int result = proc_pidfdinfo(pid, fd, flavor, buffer, size);
  const int saved_errno = errno;
  if ((result != size || saved_errno != 0) && diagnostic_event("proc_pidfdinfo")) {
    fprintf(stderr, ",\"pid\":%d,\"fd\":%d,\"flavor\":%d,\"returnedBytes\":%d,\"requestedBytes\":%d,\"errno\":%d}\n",
      pid, fd, flavor, result, size, saved_errno);
  }
  errno = saved_errno;
  return result;
}

static int diagnostic_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int size) {
  const int result = proc_listpids(type, typeinfo, buffer, size);
  const int saved_errno = errno;
  if (diagnostic_event("proc_listpids")) fprintf(stderr,
    ",\"type\":%u,\"typeinfo\":%u,\"returnedBytes\":%d,\"requestedBytes\":%d,\"errno\":%d}\n",
    (unsigned int)type, (unsigned int)typeinfo, result, size, saved_errno);
  errno = saved_errno;
  return result;
}

/* Headers above declare the real functions before these call-site substitutions. */
#define proc_pidinfo diagnostic_pidinfo
#define proc_pidfdinfo diagnostic_pidfdinfo
#define proc_listpids diagnostic_listpids
#include "../../native/maintenance-darwin.c"
