/* Reading record, Merkle tree and signed digests, as specified in
 * device/SPEC.md. The gateway's lib/reading.ts, lib/merkle.ts and
 * lib/digest.ts implement the same thing; test-vectors.json ties them. */
#ifndef KUTLE_CORE_H
#define KUTLE_CORE_H

#include <stddef.h>
#include <stdint.h>

#include "kutle_keccak.h"

#ifdef __cplusplus
extern "C" {
#endif

#define KUTLE_WIRE_BYTES 49
#define KUTLE_ENCODED_BYTES (17 * 32)

typedef struct {
  uint64_t timestamp;
  uint32_t cycle_count;
  uint32_t design_capacity_mah;
  uint32_t full_charge_capacity_mah;
  uint32_t pack_voltage_mv;
  int32_t current_ma;
  int16_t temperature_centic;
  uint8_t soc_pct;
  uint16_t cell_voltage_mv[3];
  uint16_t cell_qmax_mah[3];
  uint16_t cell_resistance[3];
} kutle_reading_t;

/* Returns 0, or -1 when a field is out of range (state of charge above 100). */
int kutle_reading_from_wire(const uint8_t wire[KUTLE_WIRE_BYTES], kutle_reading_t *r);
int kutle_reading_to_wire(const kutle_reading_t *r, uint8_t wire[KUTLE_WIRE_BYTES]);
void kutle_reading_encode(const kutle_reading_t *r, uint8_t out[KUTLE_ENCODED_BYTES]);
/* leaf = keccak256(keccak256(abi.encode(reading))) */
void kutle_reading_leaf(const kutle_reading_t *r, uint8_t leaf[32]);

/* SBS 0x08 reports 0.1 K. */
int16_t kutle_decikelvin_to_centic(uint16_t dk);

/* keccak256(min(a,b) || max(a,b)) */
void kutle_hash_pair(const uint8_t a[32], const uint8_t b[32], uint8_t out[32]);
/* Root over n >= 1 leaves. Overwrites `nodes`. Returns -1 when n == 0. */
int kutle_merkle_root(uint8_t (*nodes)[32], size_t n, uint8_t root[32]);
/* ReadingLog.verifyReading's fold. Returns 1 when the proof reaches root. */
int kutle_merkle_verify(const uint8_t leaf[32], const uint8_t (*proof)[32], size_t len, const uint8_t root[32]);

void kutle_batch_digest(const uint8_t chain_id[32], const uint8_t reading_log[20], const uint8_t device_id[32],
                        const uint8_t passport_id[32], uint64_t seq, const uint8_t root[32], uint64_t from_ts,
                        uint64_t to_ts, uint32_t count, uint8_t out[32]);
void kutle_pop_digest(const uint8_t chain_id[32], const uint8_t registry[20], const uint8_t device_id[32],
                      uint32_t version, const uint8_t signer[20], const uint8_t pk_hash[32], uint8_t out[32]);
/* keccak256("\x19Ethereum Signed Message:\n32" || digest) */
void kutle_eth_signed_hash(const uint8_t digest[32], uint8_t out[32]);
/* keccak256("KUTLE_SEED_COMMIT_V1" || xi) */
void kutle_seed_commitment(const uint8_t xi[32], uint8_t out[32]);

/* Lowercase hex without 0x. Decode accepts an optional 0x prefix and
 * returns 0 on success, -1 on a wrong length or a non-hex character. */
int kutle_hex_decode(const char *hex, uint8_t *out, size_t outlen);
void kutle_hex_encode(const uint8_t *in, size_t len, char *out); /* writes 2*len chars plus NUL */

#ifdef __cplusplus
}
#endif
#endif
