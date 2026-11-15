/* Private F3 guest. Existing F2 primitives remain byte-for-byte read-only. */
#define F2_PURE_TEST 1
#include "f2-guest.c"
#include <sys/xattr.h>

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "The fixed F3 guest ABI is x86_64 little endian"
#endif

#define F3_BLOCK_BYTES 4096U
#define F3_BLOCKS 16384U
#define F3_FRAME_BYTES 65536U
/* Reserve the remaining serial budget for unchanged P1/native/cleanup output. */
#define F3_ENCODED_BYTES (7U * 1024U * 1024U)
static unsigned f3_sequence;
static size_t f3_wire_bytes;

static int f3_event(const char *name, const char *phase, int error, int close_error,
                    const void *data, size_t length) {
    char line[F3_FRAME_BYTES];
    if (length > (F3_FRAME_BYTES - 512U) / 2U) { output_error = true; return EFBIG; }
    int n = snprintf(line, sizeof(line),
        "BRDF3 {\"run_id\":\"%s\",\"origin\":\"management\",\"seq\":%u,"
        "\"event\":\"%s\",\"phase\":\"%s\",\"rc\":%d,\"errno\":%d,\"close_errno\":%d,"
        "\"bytes\":%zu,\"data_hex\":\"", run_id, ++f3_sequence, name, phase,
        error || close_error ? -1 : 0, error, close_error, length);
    if (n < 0 || (size_t)n + 2U * length + 4U > sizeof(line)) { output_error = true; return EFBIG; }
    static const char hex[] = "0123456789abcdef";
    const unsigned char *raw = data;
    for (size_t i = 0; i < length; ++i) {
        line[n++] = hex[raw[i] >> 4]; line[n++] = hex[raw[i] & 15];
    }
    memcpy(line + n, "\"}\n", 3); n += 3;
    if ((size_t)n > F3_ENCODED_BYTES - f3_wire_bytes) { output_error = true; return EFBIG; }
    f3_wire_bytes += (size_t)n;
    if (fwrite(line, 1, (size_t)n, stdout) != (size_t)n || fflush(stdout) || ferror(stdout)) {
        output_error = true; return errno ? errno : EIO;
    }
    return 0;
}

/* Every block is actually read once. A short/error read is not a zero run.
 * The outer production owner binds this FD to its exact whole-brd and closes it.
 * Pure controls call this stream function with an owned regular-file FD only. */
static int f3_stream_blocks(const char *phase, int fd) {
    unsigned char raw[F3_BLOCK_BYTES + sizeof(uint32_t)];
    uint32_t zero_start = 0, zero_count = 0;
    for (uint32_t index = 0; index < F3_BLOCKS; ++index) {
        int error = read_at(fd, raw + sizeof(index), F3_BLOCK_BYTES, (uint64_t)index * F3_BLOCK_BYTES);
        if (error) return error;
        bool all_zero = true;
        for (size_t j = sizeof(index); j < sizeof(raw); ++j) if (raw[j]) { all_zero = false; break; }
        if (all_zero) {
            if (!zero_count) zero_start = index;
            ++zero_count;
            continue;
        }
        if (zero_count) {
            uint32_t run[] = {zero_start, zero_count};
            error = f3_event("snapshot-zero", phase, 0, 0, run, sizeof(run));
            if (error) return error;
            zero_count = 0;
        }
        memcpy(raw, &index, sizeof(index));
        error = f3_event("snapshot-data", phase, 0, 0, raw, sizeof(raw));
        if (error) return error;
    }
    if (zero_count) {
        uint32_t run[] = {zero_start, zero_count};
        return f3_event("snapshot-zero", phase, 0, 0, run, sizeof(run));
    }
    return 0;
}
