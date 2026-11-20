/* 原 DM-owned guest 的新固定 profile。管理、P1、control 和 metadata
 * 原件直接包含；只有第二轮 ordinary selected child 调用新有限 C target。 */
#define F3_DM_PURE_TEST 1
#include "f3-dm-guest.c"
#include "f4-cfp2-worker.h"

int f4_cfp2_target(const char *, const char *);

int main(int argc, char **argv) {
  (void)f3_bootstrap; (void)bootstrap_f2; (void)metadata;
  if (argc != 2 || (strcmp(argv[1], "bootstrap") && strcmp(argv[1], "p1") && strcmp(argv[1], "metadata")
      && strcmp(argv[1], "context") && strcmp(argv[1], "ordinary"))) return 64;
  bool boot = !strcmp(argv[1], "bootstrap");
  if (boot ? (getpid() != 1 || getuid() || geteuid()) : (getuid() != 1000 || geteuid() != 1000 || getppid() != 1)) return 77;
  if (load_uuid("/run/run-id", run_id) || load_uuid("/run/fs-uuid", fs_uuid) ||
      load_uuid("/run/hash-seed", hash_seed) || dm_names()) return 65;
  if (boot) return dm_bootstrap();
  if (!strcmp(argv[1], "p1")) return collect_p1();
  if (dm_ordinary_fds()) return 77;
  /* 不调用旧 dm_load_source：它会在新 D0 前打开 source。新 worker 的
   * 唯一 Dp 首次解析取得实际 device，原始 DM name/uuid/graph 同次核验。 */
  if (!strcmp(argv[1], "ordinary")) return f4_cfp2_target(run_id, fs_uuid);
  if (dm_load_source()) return 77;
  if (!strcmp(argv[1], "metadata")) return dm_metadata();
  char *native_argv[] = {"brdf3-dm-native", argv[1], "1000", "1000", "/mnt/brd", NULL};
  return brdf3_sp_main(5, native_argv);
}
