/* Device key pair: a secp256k1 key and an ML-DSA-44 key re-derived from its
 * KeyGen seed xi (device/SPEC.md section 4). */
#ifndef KUTLE_KEYS_H
#define KUTLE_KEYS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define KUTLE_MLDSA_PK_BYTES 1312
#define KUTLE_MLDSA_SK_BYTES 2560
#define KUTLE_MLDSA_SIG_BYTES 2420
#define KUTLE_ECDSA_SIG_BYTES 65

typedef int (*kutle_rng_fn)(uint8_t *out, size_t len);

typedef struct {
  uint8_t ecdsa_key[32];
  uint8_t xi[32];
  uint8_t address[20];
  uint8_t pk[KUTLE_MLDSA_PK_BYTES];
  uint8_t sk[KUTLE_MLDSA_SK_BYTES];
  uint8_t pk_hash[32];
  uint8_t commitment[32];
} kutle_keys_t;

/* Creates the secp256k1 context and blinds it with fresh randomness. The RNG
 * is also what mldsa-native's randombytes() draws from for hedged signing. */
int kutle_crypto_init(kutle_rng_fn rng);

/* Fresh secrets from the RNG; the ECDSA key is redrawn until it is a valid
 * scalar. Fills ecdsa_key and xi only. */
int kutle_keys_generate(kutle_keys_t *k);

/* From ecdsa_key and xi: address, ML-DSA key pair, pk_hash, commitment. */
int kutle_keys_derive(kutle_keys_t *k);

/* ECDSA (EIP-191, r||s||v, low s) and ML-DSA-44 (empty context) over digest. */
int kutle_sign_digest(const kutle_keys_t *k, const uint8_t digest[32], uint8_t ecdsa[KUTLE_ECDSA_SIG_BYTES],
                      uint8_t mldsa[KUTLE_MLDSA_SIG_BYTES]);

/* ML-DSA-44 alone, for the BENCH command. */
int kutle_mldsa_sign_digest(const kutle_keys_t *k, const uint8_t digest[32], uint8_t mldsa[KUTLE_MLDSA_SIG_BYTES]);

/* ML-DSA-44 verification, used by self-tests. Returns 0 when valid. */
int kutle_mldsa_verify_digest(const uint8_t pk[KUTLE_MLDSA_PK_BYTES], const uint8_t digest[32],
                              const uint8_t sig[KUTLE_MLDSA_SIG_BYTES]);

/* Seed export to the provisioning station (SPEC.md 4.1). `ephemeral` is a
 * fresh random scalar; the caller draws it so tests can be deterministic. */
int kutle_wrap_seed(const kutle_keys_t *k, const uint8_t station_pub[33], const uint8_t ephemeral[32],
                    uint8_t E[33], uint8_t ct[32], uint8_t tag[32]);

void kutle_wipe(void *p, size_t n);

#ifdef __cplusplus
}
#endif
#endif
