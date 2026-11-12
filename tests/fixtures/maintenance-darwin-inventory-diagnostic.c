/* Test-only tracing of the unchanged native inventory. Never used by the adapter. */
#include <sys/types.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

static unsigned int diagnostic_events;
static bool diagnostic_event(const char *api) {
  if (diagnostic_events++ < 4096) {
    fprintf(stderr, "{\"api\":\"%s\"", api);
    return true;
  }
  if (diagnostic_events == 4097) fputs("{\"diagnosticTruncated\":true,\"limit\":4096}\n", stderr);
  return false;
}

static int diagnostic_pidinfo(int pid, int flavor, uint64_t argument, void *buffer, int size) {
  const int result = proc_pidinfo(pid, flavor, argument, buffer, size);
  const int saved_errno = errno;
  const bool identity = flavor == PROC_PIDTBSDINFO && result == (int)sizeof(struct proc_bsdinfo);
  const bool region = flavor == PROC_PIDREGIONPATHINFO && result == (int)sizeof(struct proc_regionwithpathinfo);
  const struct proc_regionwithpathinfo *mapping = region ? buffer : NULL;
  const bool invalid_range = mapping && (mapping->prp_prinfo.pri_size == 0
    || mapping->prp_prinfo.pri_address > UINT64_MAX - mapping->prp_prinfo.pri_size
    || mapping->prp_prinfo.pri_address + mapping->prp_prinfo.pri_size <= argument);
  /* Successful ordinary regions can be numerous. Keep terminal/error calls and range failures. */
  if ((flavor != PROC_PIDREGIONPATHINFO || !region || invalid_range) && diagnostic_event("proc_pidinfo")) {
    const char *name = flavor == PROC_PIDTBSDINFO ? "PROC_PIDTBSDINFO"
      : flavor == PROC_PIDLISTFDS ? "PROC_PIDLISTFDS" : "PROC_PIDREGIONPATHINFO";
    fprintf(stderr, ",\"pid\":%d,\"flavor\":%d,\"flavorName\":\"%s\",\"argument\":\"%" PRIu64 "\",\"returnedBytes\":%d,\"requestedBytes\":%d,\"errno\":%d",
      pid, flavor, name, argument, result, size, saved_errno);
    if (identity) {
      const struct proc_bsdinfo *process = buffer;
      fprintf(stderr, ",\"identityPid\":%u,\"uid\":%u,\"startSeconds\":\"%" PRIu64 "\",\"startMicroseconds\":\"%" PRIu64 "\"",
        (unsigned int)process->pbi_pid, (unsigned int)process->pbi_uid, process->pbi_start_tvsec, process->pbi_start_tvusec);
    }
    if (mapping) fprintf(stderr, ",\"mappingBegin\":\"%" PRIu64 "\",\"mappingSize\":\"%" PRIu64 "\"",
      (uint64_t)mapping->prp_prinfo.pri_address, (uint64_t)mapping->prp_prinfo.pri_size);
    fputs("}\n", stderr);
  }
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
