/* 固定新 driver 入口；跨 TU 不接受外部提供的 FD 或源路径。 */
#include "f4-cfp2-worker.h"

int f4_cfp2_target(const char *run_id, const char *filesystem_uuid) {
  return f4_cfp2_run(run_id, filesystem_uuid);
}
