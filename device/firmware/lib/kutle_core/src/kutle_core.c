#include "kutle_core.h"

#include <string.h>

/* ------------------------------------------------------------ big endian */

static uint64_t be_get(const uint8_t *p, int n) {
  uint64_t v = 0;
  for (int i = 0; i < n; i++) v = (v << 8) | p[i];
  return v;
}

static void be_put(uint8_t *p, uint64_t v, int n) {
  for (int i = n - 1; i >= 0; i--) {
    p[i] = (uint8_t)v;
    v >>= 8;
  }
}

/* --------------------------------------------------------------- reading */

int kutle_reading_from_wire(const uint8_t w[KUTLE_WIRE_BYTES], kutle_reading_t *r) {
  r->timestamp = be_get(w, 8);
  r->cycle_count = (uint32_t)be_get(w + 8, 4);
  r->design_capacity_mah = (uint32_t)be_get(w + 12, 4);
  r->full_charge_capacity_mah = (uint32_t)be_get(w + 16, 4);
  r->pack_voltage_mv = (uint32_t)be_get(w + 20, 4);
  r->current_ma = (int32_t)(uint32_t)be_get(w + 24, 4);
  r->temperature_centic = (int16_t)(uint16_t)be_get(w + 28, 2);
  r->soc_pct = w[30];
  for (int i = 0; i < 3; i++) {
    r->cell_voltage_mv[i] = (uint16_t)be_get(w + 31 + 2 * i, 2);
    r->cell_qmax_mah[i] = (uint16_t)be_get(w + 37 + 2 * i, 2);
    r->cell_resistance[i] = (uint16_t)be_get(w + 43 + 2 * i, 2);
  }
  return r->soc_pct > 100 ? -1 : 0;
}

int kutle_reading_to_wire(const kutle_reading_t *r, uint8_t w[KUTLE_WIRE_BYTES]) {
  if (r->soc_pct > 100) return -1;
  be_put(w, r->timestamp, 8);
  be_put(w + 8, r->cycle_count, 4);
  be_put(w + 12, r->design_capacity_mah, 4);
  be_put(w + 16, r->full_charge_capacity_mah, 4);
  be_put(w + 20, r->pack_voltage_mv, 4);
  be_put(w + 24, (uint32_t)r->current_ma, 4);
  be_put(w + 28, (uint16_t)r->temperature_centic, 2);
  w[30] = r->soc_pct;
  for (int i = 0; i < 3; i++) {
    be_put(w + 31 + 2 * i, r->cell_voltage_mv[i], 2);
    be_put(w + 37 + 2 * i, r->cell_qmax_mah[i], 2);
    be_put(w + 43 + 2 * i, r->cell_resistance[i], 2);
  }
  return 0;
}

/* One ABI word: unsigned values zero-padded, signed values sign-extended. */
static void word_u(uint8_t *w, uint64_t v) {
  memset(w, 0, 24);
  be_put(w + 24, v, 8);
}

static void word_i(uint8_t *w, int64_t v) {
  memset(w, v < 0 ? 0xff : 0x00, 24);
  be_put(w + 24, (uint64_t)v, 8);
}

void kutle_reading_encode(const kutle_reading_t *r, uint8_t out[KUTLE_ENCODED_BYTES]) {
  uint8_t *w = out;
  word_u(w, r->timestamp), w += 32;
  word_u(w, r->cycle_count), w += 32;
  word_u(w, r->design_capacity_mah), w += 32;
  word_u(w, r->full_charge_capacity_mah), w += 32;
  word_u(w, r->pack_voltage_mv), w += 32;
  word_i(w, r->current_ma), w += 32;
  word_i(w, r->temperature_centic), w += 32;
  word_u(w, r->soc_pct), w += 32;
  for (int i = 0; i < 3; i++) word_u(w, r->cell_voltage_mv[i]), w += 32;
  for (int i = 0; i < 3; i++) word_u(w, r->cell_qmax_mah[i]), w += 32;
  for (int i = 0; i < 3; i++) word_u(w, r->cell_resistance[i]), w += 32;
}

void kutle_reading_leaf(const kutle_reading_t *r, uint8_t leaf[32]) {
  uint8_t enc[KUTLE_ENCODED_BYTES];
  uint8_t inner[32];
  kutle_reading_encode(r, enc);
  kutle_keccak256(enc, sizeof enc, inner);
  kutle_keccak256(inner, 32, leaf);
}

int16_t kutle_decikelvin_to_centic(uint16_t dk) { return (int16_t)((int32_t)dk * 10 - 27315); }

/* ---------------------------------------------------------------- merkle */

void kutle_hash_pair(const uint8_t a[32], const uint8_t b[32], uint8_t out[32]) {
  uint8_t buf[64];
  int a_first = memcmp(a, b, 32) < 0;
  memcpy(buf, a_first ? a : b, 32);
  memcpy(buf + 32, a_first ? b : a, 32);
  kutle_keccak256(buf, 64, out);
}

int kutle_merkle_root(uint8_t (*nodes)[32], size_t n, uint8_t root[32]) {
  if (n == 0) return -1;
  while (n > 1) {
    size_t m = 0;
    for (size_t i = 0; i < n; i += 2) {
      if (i + 1 < n) {
        uint8_t h[32];
        kutle_hash_pair(nodes[i], nodes[i + 1], h);
        memcpy(nodes[m++], h, 32);
      } else {
        if (m != i) memcpy(nodes[m], nodes[i], 32);
        m++;
      }
    }
    n = m;
  }
  memcpy(root, nodes[0], 32);
  return 0;
}

int kutle_merkle_verify(const uint8_t leaf[32], const uint8_t (*proof)[32], size_t len, const uint8_t root[32]) {
  uint8_t h[32];
  memcpy(h, leaf, 32);
  for (size_t i = 0; i < len; i++) kutle_hash_pair(h, proof[i], h);
  return memcmp(h, root, 32) == 0;
}

/* --------------------------------------------------------------- digests */

static void word_addr(uint8_t *w, const uint8_t a[20]) {
  memset(w, 0, 12);
  memcpy(w + 12, a, 20);
}

static void keccak_str(const char *s, uint8_t out[32]) { kutle_keccak256((const uint8_t *)s, strlen(s), out); }

void kutle_batch_digest(const uint8_t chain_id[32], const uint8_t reading_log[20], const uint8_t device_id[32],
                        const uint8_t passport_id[32], uint64_t seq, const uint8_t root[32], uint64_t from_ts,
                        uint64_t to_ts, uint32_t count, uint8_t out[32]) {
  uint8_t buf[10 * 32];
  keccak_str("KutleReadingBatch(bytes32 deviceId,uint256 passportId,uint64 seq,bytes32 root,uint64 fromTs,uint64 toTs,uint32 count)",
             buf);
  memcpy(buf + 32, chain_id, 32);
  word_addr(buf + 64, reading_log);
  memcpy(buf + 96, device_id, 32);
  memcpy(buf + 128, passport_id, 32);
  word_u(buf + 160, seq);
  memcpy(buf + 192, root, 32);
  word_u(buf + 224, from_ts);
  word_u(buf + 256, to_ts);
  word_u(buf + 288, count);
  kutle_keccak256(buf, sizeof buf, out);
}

void kutle_pop_digest(const uint8_t chain_id[32], const uint8_t registry[20], const uint8_t device_id[32],
                      uint32_t version, const uint8_t signer[20], const uint8_t pk_hash[32], uint8_t out[32]) {
  uint8_t buf[7 * 32];
  keccak_str("KUTLE_DEVICE_POP_V1", buf);
  memcpy(buf + 32, chain_id, 32);
  word_addr(buf + 64, registry);
  memcpy(buf + 96, device_id, 32);
  word_u(buf + 128, version);
  word_addr(buf + 160, signer);
  memcpy(buf + 192, pk_hash, 32);
  kutle_keccak256(buf, sizeof buf, out);
}

void kutle_eth_signed_hash(const uint8_t digest[32], uint8_t out[32]) {
  static const char prefix[] = "\x19" "Ethereum Signed Message:\n32";
  uint8_t buf[sizeof prefix - 1 + 32];
  memcpy(buf, prefix, sizeof prefix - 1);
  memcpy(buf + sizeof prefix - 1, digest, 32);
  kutle_keccak256(buf, sizeof buf, out);
}

void kutle_seed_commitment(const uint8_t xi[32], uint8_t out[32]) {
  static const char tag[] = "KUTLE_SEED_COMMIT_V1";
  kutle_keccak_ctx c;
  kutle_keccak_init(&c);
  kutle_keccak_update(&c, (const uint8_t *)tag, sizeof tag - 1);
  kutle_keccak_update(&c, xi, 32);
  kutle_keccak_final(&c, out);
}

/* ------------------------------------------------------------------- hex */

static int nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int kutle_hex_decode(const char *hex, uint8_t *out, size_t outlen) {
  if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
  if (strlen(hex) != 2 * outlen) return -1;
  for (size_t i = 0; i < outlen; i++) {
    int hi = nibble(hex[2 * i]), lo = nibble(hex[2 * i + 1]);
    if (hi < 0 || lo < 0) return -1;
    out[i] = (uint8_t)(hi << 4 | lo);
  }
  return 0;
}

void kutle_hex_encode(const uint8_t *in, size_t len, char *out) {
  static const char d[] = "0123456789abcdef";
  for (size_t i = 0; i < len; i++) {
    out[2 * i] = d[in[i] >> 4];
    out[2 * i + 1] = d[in[i] & 15];
  }
  out[2 * len] = 0;
}
