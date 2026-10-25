/* Keccak-256 as used by Ethereum (original Keccak padding 0x01, not SHA3's
 * 0x06). Small and portable; checked against viem by test-vectors.json. */
#ifndef KUTLE_KECCAK_H
#define KUTLE_KECCAK_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint64_t st[25];
  size_t pos;
} kutle_keccak_ctx;

void kutle_keccak_init(kutle_keccak_ctx *c);
void kutle_keccak_update(kutle_keccak_ctx *c, const uint8_t *in, size_t len);
void kutle_keccak_final(kutle_keccak_ctx *c, uint8_t out[32]);
void kutle_keccak256(const uint8_t *in, size_t len, uint8_t out[32]);

#ifdef __cplusplus
}
#endif
#endif
