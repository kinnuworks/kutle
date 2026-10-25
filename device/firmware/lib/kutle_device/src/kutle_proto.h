/* Gateway-to-device line protocol (device/SPEC.md section 5). Platform code
 * supplies a HAL; the same protocol code runs on the ESP32-S3 (src/main.cpp)
 * and on the host (sim/sim_main.c). */
#ifndef KUTLE_PROTO_H
#define KUTLE_PROTO_H

#include <stddef.h>
#include <stdint.h>

#include "kutle_core.h"

#ifdef __cplusplus
extern "C" {
#endif

#ifndef KUTLE_MAX_BATCH
#define KUTLE_MAX_BATCH 256
#endif

typedef struct {
  const char *firmware; /* e.g. "kutle-fw/1.0.0" */
  const char *mode;     /* "host-fed" or "smbus" */
  int (*rng)(uint8_t *out, size_t len);
  /* Non-volatile storage. get returns the number of bytes read, or -1 when the
   * key does not exist. put returns 0 on success. Keys are at most 15 chars. */
  int (*store_get)(const char *key, uint8_t *buf, size_t len);
  int (*store_put)(const char *key, const uint8_t *buf, size_t len);
  /* Write one line; the HAL appends "\n". */
  void (*write_line)(const char *line);
  /* smbus mode only (may be NULL in host-fed mode). Fills every field except
   * the timestamp. Returns 0 on success. */
  int (*gauge_read)(kutle_reading_t *r);
  /* Microsecond counter for timing diagnostics; may be NULL. */
  uint64_t (*micros)(void);
  /* Free stack of the calling task in bytes, for diagnostics; may be NULL. */
  uint32_t (*stack_free)(void);
} kutle_hal_t;

/* Loads the device secrets from storage, or generates and stores them on first
 * boot, then derives the key pair. Returns 0 on success. */
int kutle_proto_init(const kutle_hal_t *hal);

/* Handle one received line (without the trailing newline). May be modified. */
void kutle_proto_line(char *line);

/* smbus mode: take one sample now (also called from the sampling timer).
 * Returns 0 on success. */
int kutle_proto_sample(void);

/* Device clock, set by TIME. Zero until set. */
uint64_t kutle_proto_now(void);
void kutle_proto_tick_ms(uint32_t elapsed_ms);

#ifdef __cplusplus
}
#endif
#endif
