/* Controlled libproc responses drive the production scanner. The target vnode is a real live mmap with its FD closed. */
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/proc_info.h>
#include <mach/vm_inherit.h>
#include <mach/vm_statistics.h>
#include <libproc.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

static const char *scenario;
static unsigned int fixture_calls;
static uint64_t fixture_queries[16];
static struct proc_regionwithpathinfo target_region;
static const uint64_t fixture_page = 16384;
static bool is_case(const char *name) { return strcmp(scenario, name) == 0; }

static void guard_response(struct proc_regionwithpathinfo *region, uint64_t begin) {
  memset(region, 0, sizeof(*region));
  region->prp_prinfo.pri_address = begin;
  region->prp_prinfo.pri_inheritance = VM_INHERIT_NONE;
  region->prp_prinfo.pri_user_tag = VM_MEMORY_GUARD;
  region->prp_prinfo.pri_share_mode = SM_EMPTY;
}
static void anonymous_response(struct proc_regionwithpathinfo *region, uint64_t begin) {
  memset(region, 0, sizeof(*region));
  region->prp_prinfo.pri_address = begin; region->prp_prinfo.pri_size = fixture_page;
  region->prp_prinfo.pri_protection = 3; region->prp_prinfo.pri_max_protection = 3;
  region->prp_prinfo.pri_share_mode = SM_PRIVATE;
}

static int fixture_pidinfo(int pid, int flavor, uint64_t argument, void *buffer, int size) {
  if (pid != getpid() || flavor != PROC_PIDREGIONPATHINFO || size != (int)sizeof(target_region)) { errno = EINVAL; return 0; }
  const unsigned int call = ++fixture_calls;
  if (call <= 16) fixture_queries[call - 1] = argument;
  struct proc_regionwithpathinfo *region = buffer;
  errno = 0;
  if (is_case("budget")) { anonymous_response(region, argument); return size; }
  if (is_case("guard-budget")) {
    if (call % 2) guard_response(region, argument + fixture_page); else anonymous_response(region, argument);
    return size;
  }
  if (call == 1) {
    if (is_case("normal-denied")) { errno = EACCES; return 0; }
    if (is_case("normal-target")) { *region = target_region; return size; }
    if (is_case("normal-overflow")) { anonymous_response(region, UINT64_MAX - 1); return size; }
    if (is_case("guard-backward") || is_case("normal-nonprogress")) { anonymous_response(region, 0); return size; }
    const uint64_t begin = target_region.prp_prinfo.pri_address - (is_case("guard-anonymous-target") ? fixture_page : 0);
    guard_response(region, is_case("guard-nonprogress") ? 0 : begin);
    if (is_case("guard-vnode")) region->prp_vip = target_region.prp_vip;
    if (is_case("guard-other-tag")) region->prp_prinfo.pri_user_tag = 0;
    if (is_case("guard-writable")) region->prp_prinfo.pri_protection = 3;
    if (is_case("guard-max-write")) region->prp_prinfo.pri_max_protection = 3;
    if (is_case("guard-submap")) region->prp_prinfo.pri_flags = PROC_REGION_SUBMAP;
    if (is_case("guard-nonempty")) region->prp_prinfo.pri_share_mode = SM_SHARED;
    if (is_case("guard-counter")) region->prp_prinfo.pri_ref_count = 1;
    if (is_case("guard-offset")) region->prp_prinfo.pri_offset = 1;
    return size;
  }
  if (call == 2) {
    if (is_case("guard-backward")) { guard_response(region, 0); return size; }
    if (is_case("normal-nonprogress")) { anonymous_response(region, 0); return size; }
    if (is_case("normal-target")) { errno = EINVAL; return 0; }
    if (is_case("guard-anonymous-target")) { anonymous_response(region, argument); return size; }
    if (is_case("confirm-einval")) { errno = EINVAL; return 0; }
    if (is_case("confirm-esrch")) { errno = ESRCH; return 0; }
    if (is_case("confirm-denied")) { errno = EACCES; return 0; }
    if (is_case("confirm-short")) { *region = target_region; return size - 1; }
    if (is_case("confirm-zero") || is_case("confirm-forward-zero")) {
      guard_response(region, argument + (is_case("confirm-forward-zero") ? fixture_page : 0)); return size;
    }
    *region = target_region;
    if (is_case("confirm-forward")) region->prp_prinfo.pri_address += fixture_page;
    if (is_case("confirm-backward")) region->prp_prinfo.pri_address -= fixture_page;
    if (is_case("confirm-overflow")) region->prp_prinfo.pri_size = UINT64_MAX;
    return size;
  }
  if (call == 3 && is_case("guard-anonymous-target")) { *region = target_region; return size; }
  errno = EINVAL; return 0;
}

/* Compile the exact production scanner; only its libproc calls are controlled in this test executable. */
#define main maintenance_native_entry
#define proc_pidinfo fixture_pidinfo
#include "../../native/maintenance-darwin.c"
#undef proc_pidinfo
#undef main

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  scenario = argv[1];
  int fd = open(argv[2], O_RDWR | O_NOFOLLOW);
  struct stat source_stat;
  if (fd < 0 || fstat(fd, &source_stat) != 0 || source_stat.st_size <= 0) return 3;
  void *mapped = mmap(NULL, (size_t)source_stat.st_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (close(fd) != 0) return 4;
  errno = 0;
  if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 4;
  if (mapped == MAP_FAILED) return 4;
  const uint64_t mapped_address = (uint64_t)(uintptr_t)mapped;
  struct proc_bsdinfo process;
  memset(&process, 0, sizeof(process)); memset(&target_region, 0, sizeof(target_region));
  /* Begin real provider binding. The portable author control check substitutes only this block. */
  if (proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &process, sizeof(process)) != (int)sizeof(process)
      || proc_pidinfo(getpid(), PROC_PIDREGIONPATHINFO, mapped_address, &target_region, sizeof(target_region)) != (int)sizeof(target_region)) return 5;
  /* End real provider binding. */
  if (target_region.prp_prinfo.pri_address != mapped_address || target_region.prp_prinfo.pri_size == 0 || mapped_address < fixture_page
      || target_region.prp_vip.vip_vi.vi_stat.vst_dev != (uint32_t)source_stat.st_dev
      || target_region.prp_vip.vip_vi.vi_stat.vst_ino != (uint64_t)source_stat.st_ino) return 6;
  scopes[0] = (struct scope){ .path = argv[2], .tree = false, .exists = true, .device = source_stat.st_dev, .inode = source_stat.st_ino };
  scope_count = 1; comma = false;
  printf("{\"items\":["); scan_mappings(getpid(), &process);
  printf("],\"queryCount\":%u,\"queries\":[", fixture_calls);
  for (unsigned int i = 0; i < fixture_calls && i < 16; i++) printf("%s\"%" PRIu64 "\"", i ? "," : "", fixture_queries[i]);
  printf("],\"mappedBegin\":\"%" PRIu64 "\",\"mappedSize\":\"%" PRIu64 "\",\"device\":\"%u\",\"inode\":\"%" PRIu64 "\",\"targetFdClosed\":true}\n",
    mapped_address, (uint64_t)target_region.prp_prinfo.pri_size, (unsigned int)source_stat.st_dev, (uint64_t)source_stat.st_ino);
  return munmap(mapped, (size_t)source_stat.st_size) == 0 ? 0 : 7;
}
