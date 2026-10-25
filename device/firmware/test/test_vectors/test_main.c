/* Native test: the firmware's encoding, Merkle, digest, key derivation,
 * signing and seed-wrap code against device/test-vectors.json, which the
 * TypeScript gateway generates and checks too.
 *
 *   pio test -e native
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unity.h>

#include "json_min.h"
#include "kutle_core.h"
#include "kutle_keys.h"

#ifndef KUTLE_VECTORS_PATH
#define KUTLE_VECTORS_PATH "../test-vectors.json"
#endif

static jnode *V;

static int test_rng(uint8_t *out, size_t len) {
  FILE *f = fopen("/dev/urandom", "rb");
  if (!f) return -1;
  size_t n = fread(out, 1, len, f);
  fclose(f);
  return n == len ? 0 : -1;
}

static void hex(const char *h, uint8_t *out, size_t len) {
  TEST_ASSERT_NOT_NULL_MESSAGE(h, "missing hex field");
  TEST_ASSERT_EQUAL_INT_MESSAGE(0, kutle_hex_decode(h, out, len), h);
}

/* Decimal string to a 32-byte big-endian word. */
static void dec_word(const char *s, uint8_t out[32]) {
  memset(out, 0, 32);
  for (; *s; s++) {
    int carry = *s - '0';
    for (int i = 31; i >= 0; i--) {
      int v = out[i] * 10 + carry;
      out[i] = (uint8_t)v;
      carry = v >> 8;
    }
  }
}

void setUp(void) {}
void tearDown(void) {}

static void test_readings(void) {
  jnode *rs = jget(V, "readings");
  TEST_ASSERT_TRUE(jlen(rs) >= 5);
  for (size_t i = 0; i < jlen(rs); i++) {
    jnode *v = jat(rs, i);
    uint8_t wire[KUTLE_WIRE_BYTES], back[KUTLE_WIRE_BYTES], enc[KUTLE_ENCODED_BYTES], want_enc[KUTLE_ENCODED_BYTES];
    uint8_t leaf[32], want_leaf[32];
    kutle_reading_t r;
    hex(jstrv(v, "wire"), wire, sizeof wire);
    TEST_ASSERT_EQUAL_INT(0, kutle_reading_from_wire(wire, &r));

    jnode *f = jget(v, "reading");
    TEST_ASSERT_EQUAL_UINT64((uint64_t)jnum(f, "timestamp"), r.timestamp);
    TEST_ASSERT_EQUAL_INT32((int32_t)jnum(f, "current_mA"), r.current_ma);
    TEST_ASSERT_EQUAL_INT16((int16_t)jnum(f, "temperature_centiC"), r.temperature_centic);

    hex(jstrv(v, "encoded"), want_enc, sizeof want_enc);
    kutle_reading_encode(&r, enc);
    TEST_ASSERT_EQUAL_MEMORY(want_enc, enc, sizeof enc);

    hex(jstrv(v, "leaf"), want_leaf, 32);
    kutle_reading_leaf(&r, leaf);
    TEST_ASSERT_EQUAL_MEMORY(want_leaf, leaf, 32);

    TEST_ASSERT_EQUAL_INT(0, kutle_reading_to_wire(&r, back));
    TEST_ASSERT_EQUAL_MEMORY(wire, back, sizeof wire);
  }
}

static void test_out_of_range_soc_is_refused(void) {
  uint8_t wire[KUTLE_WIRE_BYTES];
  kutle_reading_t r;
  hex(jstrv(jat(jget(V, "readings"), 0), "wire"), wire, sizeof wire);
  wire[30] = 101;
  TEST_ASSERT_EQUAL_INT(-1, kutle_reading_from_wire(wire, &r));
}

static void test_trees(void) {
  jnode *rs = jget(V, "readings"), *ts = jget(V, "trees");
  TEST_ASSERT_EQUAL_size_t(7, jlen(ts));
  for (size_t t = 0; t < jlen(ts); t++) {
    jnode *tree = jat(ts, t);
    size_t n = (size_t)jnum(tree, "n");
    uint8_t(*nodes)[32] = malloc(n * 32);
    uint8_t(*leaves)[32] = malloc(n * 32);
    uint8_t root[32], want[32];
    for (size_t i = 0; i < n; i++) hex(jstrv(jat(rs, i), "leaf"), leaves[i], 32);
    memcpy(nodes, leaves, n * 32);
    TEST_ASSERT_EQUAL_INT(0, kutle_merkle_root(nodes, n, root));
    hex(jstrv(tree, "root"), want, 32);
    TEST_ASSERT_EQUAL_MEMORY(want, root, 32);

    jnode *proofs = jget(tree, "proofs");
    for (size_t i = 0; i < n; i++) {
      jnode *p = jat(proofs, i);
      size_t plen = jlen(p);
      uint8_t(*path)[32] = malloc((plen ? plen : 1) * 32);
      for (size_t k = 0; k < plen; k++) hex(jat(p, k)->text, path[k], 32);
      TEST_ASSERT_TRUE(kutle_merkle_verify(leaves[i], (const uint8_t(*)[32])path, plen, root));
      /* A different leaf must not verify on the same path. */
      uint8_t other[32];
      memcpy(other, leaves[i], 32);
      other[0] ^= 1;
      TEST_ASSERT_FALSE(kutle_merkle_verify(other, (const uint8_t(*)[32])path, plen, root));
      free(path);
    }
    free(nodes);
    free(leaves);
  }
  uint8_t dummy[1][32], r[32];
  TEST_ASSERT_EQUAL_INT(-1, kutle_merkle_root(dummy, 0, r));
}

static kutle_keys_t K;

static void test_key_derivation_matches_station(void) {
  jnode *k = jget(V, "keys");
  uint8_t want_pk[KUTLE_MLDSA_PK_BYTES], want[32], addr[20];
  hex(jstrv(k, "ecdsaKey"), K.ecdsa_key, 32);
  hex(jstrv(k, "xi"), K.xi, 32);
  TEST_ASSERT_EQUAL_INT(0, kutle_keys_derive(&K));
  /* KeyGen-seed binding: firmware and station derive the same key from xi. */
  hex(jstrv(k, "pk"), want_pk, sizeof want_pk);
  TEST_ASSERT_EQUAL_MEMORY(want_pk, K.pk, sizeof want_pk);
  hex(jstrv(k, "pkHash"), want, 32);
  TEST_ASSERT_EQUAL_MEMORY(want, K.pk_hash, 32);
  hex(jstrv(k, "commitment"), want, 32);
  TEST_ASSERT_EQUAL_MEMORY(want, K.commitment, 32);
  hex(jstrv(k, "address"), addr, 20);
  TEST_ASSERT_EQUAL_MEMORY(addr, K.address, 20);
}

static void test_batch_digests_and_signatures(void) {
  jnode *bs = jget(V, "batches");
  TEST_ASSERT_TRUE(jlen(bs) >= 2);
  for (size_t i = 0; i < jlen(bs); i++) {
    jnode *b = jat(bs, i);
    uint8_t chain[32], log[20], dev[32], pass[32], root[32], want[32], digest[32];
    uint8_t ecdsa[65], want_ecdsa[65], mldsa[KUTLE_MLDSA_SIG_BYTES], their_mldsa[KUTLE_MLDSA_SIG_BYTES];
    dec_word(jstrv(b, "chainId"), chain);
    hex(jstrv(b, "readingLog"), log, 20);
    hex(jstrv(b, "deviceId"), dev, 32);
    dec_word(jstrv(b, "passportId"), pass);
    hex(jstrv(b, "root"), root, 32);
    kutle_batch_digest(chain, log, dev, pass, strtoull(jstrv(b, "seq"), NULL, 10), root,
                       strtoull(jstrv(b, "fromTs"), NULL, 10), strtoull(jstrv(b, "toTs"), NULL, 10),
                       (uint32_t)jnum(b, "count"), digest);
    hex(jstrv(b, "digest"), want, 32);
    TEST_ASSERT_EQUAL_MEMORY(want, digest, 32);

    TEST_ASSERT_EQUAL_INT(0, kutle_sign_digest(&K, digest, ecdsa, mldsa));
    /* RFC 6979 on both sides: the ECDSA signature is identical to viem's. */
    hex(jstrv(b, "ecdsaSig"), want_ecdsa, 65);
    TEST_ASSERT_EQUAL_MEMORY(want_ecdsa, ecdsa, 65);
    /* ML-DSA is hedged, so compare by verification in both directions. */
    TEST_ASSERT_EQUAL_INT(0, kutle_mldsa_verify_digest(K.pk, digest, mldsa));
    hex(jstrv(b, "mldsaSig"), their_mldsa, sizeof their_mldsa);
    TEST_ASSERT_EQUAL_INT(0, kutle_mldsa_verify_digest(K.pk, digest, their_mldsa));
    digest[31] ^= 1;
    TEST_ASSERT_EQUAL_INT(-1, kutle_mldsa_verify_digest(K.pk, digest, their_mldsa));
  }
}

static void test_pop_digests(void) {
  jnode *ps = jget(V, "pops");
  for (size_t i = 0; i < jlen(ps); i++) {
    jnode *p = jat(ps, i);
    uint8_t chain[32], reg[20], dev[32], signer[20], pkh[32], want[32], got[32];
    dec_word(jstrv(p, "chainId"), chain);
    hex(jstrv(p, "registry"), reg, 20);
    hex(jstrv(p, "deviceId"), dev, 32);
    hex(jstrv(p, "ecdsaSigner"), signer, 20);
    hex(jstrv(p, "pkHash"), pkh, 32);
    kutle_pop_digest(chain, reg, dev, (uint32_t)jnum(p, "version"), signer, pkh, got);
    hex(jstrv(p, "digest"), want, 32);
    TEST_ASSERT_EQUAL_MEMORY(want, got, 32);
  }
}

static void test_seed_wrap(void) {
  jnode *w = jget(V, "wrap");
  uint8_t S[33], e[32], E[33], ct[32], tag[32], want[33];
  hex(jstrv(w, "stationPub"), S, 33);
  hex(jstrv(w, "ephemeralSecret"), e, 32);
  TEST_ASSERT_EQUAL_INT(0, kutle_wrap_seed(&K, S, e, E, ct, tag));
  hex(jstrv(w, "E"), want, 33);
  TEST_ASSERT_EQUAL_MEMORY(want, E, 33);
  hex(jstrv(w, "ct"), want, 32);
  TEST_ASSERT_EQUAL_MEMORY(want, ct, 32);
  hex(jstrv(w, "tag"), want, 32);
  TEST_ASSERT_EQUAL_MEMORY(want, tag, 32);
}

static void test_keccak_known_answers(void) {
  uint8_t out[32], want[32];
  kutle_keccak256((const uint8_t *)"", 0, out);
  hex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", want, 32);
  TEST_ASSERT_EQUAL_MEMORY(want, out, 32);
  /* 136 bytes: exactly one rate block, exercises the padding-only block. */
  uint8_t block[200];
  memset(block, 0x61, sizeof block);
  kutle_keccak256(block, 136, out);
  kutle_keccak_ctx c;
  kutle_keccak_init(&c);
  for (int i = 0; i < 136; i++) kutle_keccak_update(&c, block + i, 1);
  uint8_t out2[32];
  kutle_keccak_final(&c, out2);
  TEST_ASSERT_EQUAL_MEMORY(out, out2, 32);
}

static char *slurp(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *buf = malloc((size_t)n + 1);
  size_t got = fread(buf, 1, (size_t)n, f);
  buf[got] = 0;
  fclose(f);
  return buf;
}

int main(void) {
  char *src = slurp(KUTLE_VECTORS_PATH);
  if (!src) {
    fprintf(stderr, "cannot read %s\n", KUTLE_VECTORS_PATH);
    return 1;
  }
  V = json_parse(src);
  if (kutle_crypto_init(test_rng) != 0) return 1;
  UNITY_BEGIN();
  RUN_TEST(test_keccak_known_answers);
  RUN_TEST(test_readings);
  RUN_TEST(test_out_of_range_soc_is_refused);
  RUN_TEST(test_trees);
  RUN_TEST(test_key_derivation_matches_station);
  RUN_TEST(test_batch_digests_and_signatures);
  RUN_TEST(test_pop_digests);
  RUN_TEST(test_seed_wrap);
  return UNITY_END();
}
