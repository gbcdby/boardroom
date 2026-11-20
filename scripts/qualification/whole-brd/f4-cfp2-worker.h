#ifndef BOARDROOM_F4_CFP2_WORKER_H
#define BOARDROOM_F4_CFP2_WORKER_H
#include <stdint.h>

/* 固定普通 child 的私有入口；没有可接收调用方 FD/就绪声明的接口。 */
int f4_cfp2_run(const char *run_id, const char *filesystem_uuid);
#ifdef F4_CFP2_OWNER_CONTROL
int f4_cfp2_owner_control(void);
#endif
#endif
