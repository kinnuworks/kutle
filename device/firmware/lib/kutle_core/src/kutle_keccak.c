#include "kutle_keccak.h"

#include <string.h>

#define RATE 136

static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL,
    0x000000000000808bULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008aULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL};

static const uint8_t ROTC[24] = {1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44};
static const uint8_t PILN[24] = {10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1};

#define ROTL64(x, y) (((x) << (y)) | ((x) >> (64 - (y))))

static void keccakf(uint64_t st[25]) {
  uint64_t bc[5], t;
  for (int r = 0; r < 24; r++) {
    for (int i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (int i = 0; i < 5; i++) {
      t = bc[(i + 4) % 5] ^ ROTL64(bc[(i + 1) % 5], 1);
      for (int j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    t = st[1];
    for (int i = 0; i < 24; i++) {
      int j = PILN[i];
      bc[0] = st[j];
      st[j] = ROTL64(t, ROTC[i]);
      t = bc[0];
    }
    for (int j = 0; j < 25; j += 5) {
      for (int i = 0; i < 5; i++) bc[i] = st[j + i];
      for (int i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
    }
    st[0] ^= RC[r];
  }
}

/* Lanes are little-endian; XOR byte by byte so the code is endian-neutral. */
static void xor_byte(uint64_t st[25], size_t i, uint8_t b) { st[i >> 3] ^= (uint64_t)b << (8 * (i & 7)); }

void kutle_keccak_init(kutle_keccak_ctx *c) { memset(c, 0, sizeof(*c)); }

void kutle_keccak_update(kutle_keccak_ctx *c, const uint8_t *in, size_t len) {
  for (size_t k = 0; k < len; k++) {
    xor_byte(c->st, c->pos++, in[k]);
    if (c->pos == RATE) {
      keccakf(c->st);
      c->pos = 0;
    }
  }
}

void kutle_keccak_final(kutle_keccak_ctx *c, uint8_t out[32]) {
  xor_byte(c->st, c->pos, 0x01);
  xor_byte(c->st, RATE - 1, 0x80);
  keccakf(c->st);
  for (size_t i = 0; i < 32; i++) out[i] = (uint8_t)(c->st[i >> 3] >> (8 * (i & 7)));
  memset(c, 0, sizeof(*c));
}

void kutle_keccak256(const uint8_t *in, size_t len, uint8_t out[32]) {
  kutle_keccak_ctx c;
  kutle_keccak_init(&c);
  kutle_keccak_update(&c, in, len);
  kutle_keccak_final(&c, out);
}
