/* SPDX-License-Identifier: LGPL-2.0+ WITH Linux-syscall-note */
/* 固定 Linux 028ef9c DM v4.50.0 的最小 ABI。不得依赖宿主头文件版本漂移。 */
#ifndef BR_F3_DM_UAPI_H
#define BR_F3_DM_UAPI_H
#include <stddef.h>
#include <stdint.h>
#include <sys/ioctl.h>

struct br_dm_ioctl {
    uint32_t version[3], data_size, data_start, target_count;
    int32_t open_count;
    uint32_t flags, event_nr, padding;
    uint64_t dev;
    char name[128], uuid[129], data[7];
};
struct br_dm_target_spec {
    uint64_t sector_start, length;
    int32_t status;
    uint32_t next;
    char target_type[16];
};
struct br_dm_target_deps { uint32_t count, padding; uint64_t dev[]; };
#define BR_DM_BUFFER_BYTES 16384U
#define BR_DM_VERSION _IOWR(0xfd, 0, struct br_dm_ioctl)
#define BR_DM_LIST _IOWR(0xfd, 2, struct br_dm_ioctl)
#define BR_DM_CREATE _IOWR(0xfd, 3, struct br_dm_ioctl)
#define BR_DM_REMOVE _IOWR(0xfd, 4, struct br_dm_ioctl)
#define BR_DM_RESUME _IOWR(0xfd, 6, struct br_dm_ioctl)
#define BR_DM_STATUS _IOWR(0xfd, 7, struct br_dm_ioctl)
#define BR_DM_LOAD _IOWR(0xfd, 9, struct br_dm_ioctl)
#define BR_DM_DEPS _IOWR(0xfd, 11, struct br_dm_ioctl)
#define BR_DM_TABLE _IOWR(0xfd, 12, struct br_dm_ioctl)
#define BR_DM_ACTIVE 32U
#define BR_DM_INACTIVE 64U
#define BR_DM_TABLE_FLAG 16U
#define BR_DM_UEVENT (1U << 13)

_Static_assert(sizeof(struct br_dm_ioctl) == 312 && offsetof(struct br_dm_ioctl, data) == 305, "DM header size");
_Static_assert(offsetof(struct br_dm_ioctl, data_size) == 12 && offsetof(struct br_dm_ioctl, data_start) == 16, "DM size offsets");
_Static_assert(offsetof(struct br_dm_ioctl, open_count) == 24 && offsetof(struct br_dm_ioctl, flags) == 28, "DM flags offsets");
_Static_assert(offsetof(struct br_dm_ioctl, dev) == 40 && offsetof(struct br_dm_ioctl, name) == 48 && offsetof(struct br_dm_ioctl, uuid) == 176, "DM identity offsets");
_Static_assert(sizeof(struct br_dm_target_spec) == 40 && offsetof(struct br_dm_target_spec, next) == 20 && offsetof(struct br_dm_target_spec, target_type) == 24, "DM target ABI");
_Static_assert(sizeof(struct br_dm_target_deps) == 8 && offsetof(struct br_dm_target_deps, dev) == 8, "DM deps ABI");
_Static_assert(BR_DM_VERSION == 0xc138fd00UL && BR_DM_LIST == 0xc138fd02UL && BR_DM_CREATE == 0xc138fd03UL, "DM top-level ioctl ABI");
_Static_assert(BR_DM_REMOVE == 0xc138fd04UL && BR_DM_RESUME == 0xc138fd06UL && BR_DM_STATUS == 0xc138fd07UL, "DM device ioctl ABI");
_Static_assert(BR_DM_LOAD == 0xc138fd09UL && BR_DM_DEPS == 0xc138fd0bUL && BR_DM_TABLE == 0xc138fd0cUL, "DM table ioctl ABI");
#endif
