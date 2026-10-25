#include "kutle_keys.h"

#include <string.h>

#include "kutle_core.h"
#include "mldsa_native.h"
#include "secp256k1.h"
#include "secp256k1_ecdh.h"
#include "secp256k1_recovery.h"

static secp256k1_context *g_ctx;
static kutle_rng_fn g_rng;

/* mldsa-native draws the per-signature randomness for hedged signing here. */
int randombytes(uint8_t *out, size_t outlen) { return g_rng ? g_rng(out, outlen) : -1; }

void kutle_wipe(void *p, size_t n) {
  volatile uint8_t *v = (volatile uint8_t *)p;
  while (n--) *v++ = 0;
}

int kutle_crypto_init(kutle_rng_fn rng) {
  uint8_t blind[32];
  g_rng = rng;
  if (g_ctx == NULL) g_ctx = secp256k1_context_create(SECP256K1_CONTEXT_NONE);
  if (g_ctx == NULL) return -1;
  if (rng(blind, sizeof blind) != 0) return -2;
  int ok = secp256k1_context_randomize(g_ctx, blind);
  kutle_wipe(blind, sizeof blind);
  return ok ? 0 : -3;
}

int kutle_keys_generate(kutle_keys_t *k) {
  memset(k, 0, sizeof *k);
  for (int tries = 0; tries < 16; tries++) {
    if (g_rng(k->ecdsa_key, 32) != 0) return -1;
    if (secp256k1_ec_seckey_verify(g_ctx, k->ecdsa_key)) break;
    if (tries == 15) return -2;
  }
  if (g_rng(k->xi, 32) != 0) return -1;
  return 0;
}

int kutle_keys_derive(kutle_keys_t *k) {
  secp256k1_pubkey pub;
  uint8_t ser[65], h[32];
  size_t len = sizeof ser;
  if (!secp256k1_ec_pubkey_create(g_ctx, &pub, k->ecdsa_key)) return -1;
  secp256k1_ec_pubkey_serialize(g_ctx, ser, &len, &pub, SECP256K1_EC_UNCOMPRESSED);
  kutle_keccak256(ser + 1, 64, h);
  memcpy(k->address, h + 12, 20);
  /* FIPS 204 Algorithm 6: the key pair is a deterministic function of xi. */
  if (kutle_mldsa_keypair_internal(k->pk, k->sk, k->xi) != 0) return -2;
  kutle_keccak256(k->pk, KUTLE_MLDSA_PK_BYTES, k->pk_hash);
  kutle_seed_commitment(k->xi, k->commitment);
  return 0;
}

int kutle_sign_digest(const kutle_keys_t *k, const uint8_t digest[32], uint8_t ecdsa[KUTLE_ECDSA_SIG_BYTES],
                      uint8_t mldsa[KUTLE_MLDSA_SIG_BYTES]) {
  uint8_t h[32];
  int recid = 0;
  secp256k1_ecdsa_recoverable_signature sig;
  kutle_eth_signed_hash(digest, h);
  /* RFC 6979 nonce, low-s output: the same bytes viem produces. */
  if (!secp256k1_ecdsa_sign_recoverable(g_ctx, &sig, h, k->ecdsa_key, NULL, NULL)) return -1;
  secp256k1_ecdsa_recoverable_signature_serialize_compact(g_ctx, ecdsa, &recid, &sig);
  ecdsa[64] = (uint8_t)(27 + recid);
  /* Pure ML-DSA, empty context, message = the 32 digest bytes. */
  if (kutle_mldsa_signature(mldsa, digest, 32, (const uint8_t *)"", 0, k->sk) != 0) return -2;
  return 0;
}

int kutle_mldsa_sign_digest(const kutle_keys_t *k, const uint8_t digest[32], uint8_t mldsa[KUTLE_MLDSA_SIG_BYTES]) {
  return kutle_mldsa_signature(mldsa, digest, 32, (const uint8_t *)"", 0, k->sk) == 0 ? 0 : -1;
}

int kutle_mldsa_verify_digest(const uint8_t pk[KUTLE_MLDSA_PK_BYTES], const uint8_t digest[32],
                              const uint8_t sig[KUTLE_MLDSA_SIG_BYTES]) {
  return kutle_mldsa_verify(sig, digest, 32, (const uint8_t *)"", 0, pk) == 0 ? 0 : -1;
}

int kutle_wrap_seed(const kutle_keys_t *k, const uint8_t station_pub[33], const uint8_t ephemeral[32],
                    uint8_t E[33], uint8_t ct[32], uint8_t tag[32]) {
  static const char label[] = "KUTLE_SEED_WRAP_V1";
  secp256k1_pubkey S, Ep;
  uint8_t z[32], kenc[32], kmac[32], one = 1, two = 2;
  size_t len = 33;
  kutle_keccak_ctx c;

  if (!secp256k1_ec_pubkey_parse(g_ctx, &S, station_pub, 33)) return -1;
  if (!secp256k1_ec_pubkey_create(g_ctx, &Ep, ephemeral)) return -2;
  secp256k1_ec_pubkey_serialize(g_ctx, E, &len, &Ep, SECP256K1_EC_COMPRESSED);
  /* Default hash: sha256(compressed shared point). */
  if (!secp256k1_ecdh(g_ctx, z, &S, ephemeral, NULL, NULL)) return -3;

  for (int pass = 0; pass < 2; pass++) {
    kutle_keccak_init(&c);
    kutle_keccak_update(&c, pass == 0 ? &one : &two, 1);
    kutle_keccak_update(&c, z, 32);
    kutle_keccak_update(&c, (const uint8_t *)label, sizeof label - 1);
    kutle_keccak_update(&c, E, 33);
    kutle_keccak_update(&c, station_pub, 33);
    kutle_keccak_update(&c, k->address, 20);
    kutle_keccak_final(&c, pass == 0 ? kenc : kmac);
  }
  for (int i = 0; i < 32; i++) ct[i] = k->xi[i] ^ kenc[i];
  kutle_keccak_init(&c);
  kutle_keccak_update(&c, kmac, 32);
  kutle_keccak_update(&c, ct, 32);
  kutle_keccak_final(&c, tag);

  kutle_wipe(z, sizeof z);
  kutle_wipe(kenc, sizeof kenc);
  kutle_wipe(kmac, sizeof kmac);
  return 0;
}
