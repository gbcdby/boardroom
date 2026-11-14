/* SPDX-License-Identifier: GPL-2.0 WITH Linux-syscall-note */
/* Linux v7.0 UAPI 的本地命名布局；只使用 GET，不导入 SET 操作。
 * https://github.com/torvalds/linux/blob/v7.0/include/uapi/linux/ext4.h
 * https://github.com/torvalds/linux/blob/v7.0/include/uapi/linux/mount.h
 * https://github.com/torvalds/linux/blob/v7.0/arch/x86/entry/syscalls/syscall_64.tbl
 */
#ifndef BOARDROOM_R04_UAPI_H
#define BOARDROOM_R04_UAPI_H
#include <stdint.h>
#include <stddef.h>
#include <sys/ioctl.h>
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "Only the reviewed Linux x86_64 ABI is declared"
#endif
struct r04_tune {
  uint32_t set_flags, checkinterval;
  uint16_t errors_behavior, mnt_count, max_mnt_count, raid_stride;
  uint64_t last_check_time, reserved_blocks, blocks_count;
  uint32_t default_mnt_opts, reserved_uid, reserved_gid, raid_stripe_width;
  uint16_t encoding, encoding_flags;
  uint8_t def_hash_alg, pad_1;
  uint16_t pad_2;
  uint32_t feature_compat, feature_incompat, feature_ro_compat;
  uint32_t set_feature_compat_mask, set_feature_incompat_mask, set_feature_ro_compat_mask;
  uint32_t clear_feature_compat_mask, clear_feature_incompat_mask, clear_feature_ro_compat_mask;
  uint8_t mount_opts[64], pad[68];
};
struct r04_statmount {
  uint32_t size, mnt_opts;
  uint64_t mask;
  uint32_t sb_dev_major, sb_dev_minor;
  uint64_t sb_magic;
  uint32_t sb_flags, fs_type;
  uint64_t mnt_id, mnt_parent_id;
  uint32_t mnt_id_old, mnt_parent_id_old;
  uint64_t mnt_attr, mnt_propagation, mnt_peer_group, mnt_master, propagate_from;
  uint32_t mnt_root, mnt_point;
  uint64_t mnt_ns_id;
  uint32_t fs_subtype, sb_source, opt_num, opt_array, opt_sec_num, opt_sec_array;
  uint64_t supported_mask;
  uint32_t mnt_uidmap_num, mnt_uidmap, mnt_gidmap_num, mnt_gidmap;
  uint64_t spare[43];
  char str[];
};
struct r04_mnt_id_req { uint32_t size, mnt_ns_fd; uint64_t mnt_id, param, mnt_ns_id; };
#define R04_GET_TUNE _IOR('f', 45, struct r04_tune)
#ifndef SYS_statmount
#define SYS_statmount 457 /* cited x86_64 v7.0 syscall table, not a runtime guess */
#endif
#define R04_MOUNT_MASK 0x3bU
_Static_assert(sizeof(struct r04_tune)==232, "GET_TUNE ABI size");
_Static_assert(offsetof(struct r04_tune, default_mnt_opts)==40, "GET_TUNE defaults offset");
_Static_assert(offsetof(struct r04_tune, feature_compat)==64, "GET_TUNE features offset");
_Static_assert(offsetof(struct r04_tune, mount_opts)==100, "GET_TUNE text offset");
_Static_assert(R04_GET_TUNE==0x80e8662dUL, "GET_TUNE ioctl encoding");
_Static_assert(sizeof(struct r04_statmount)==512, "statmount fixed header");
_Static_assert(offsetof(struct r04_statmount, mnt_root)==104, "statmount root offset");
_Static_assert(sizeof(struct r04_mnt_id_req)==32, "statmount request ABI");
_Static_assert(SYS_statmount==457, "reviewed x86_64 syscall");
#endif
