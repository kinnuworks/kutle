#include "kutle_proto.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "kutle_keys.h"

/* Static so the large buffers stay off the task stack. */
static const kutle_hal_t *H;
static kutle_keys_t K;
static uint8_t g_locked;
static char g_out[64 + 2 * (32 + 65 + KUTLE_MLDSA_SIG_BYTES) + 128];
static uint8_t g_ecdsa[KUTLE_ECDSA_SIG_BYTES];
static uint8_t g_mldsa[KUTLE_MLDSA_SIG_BYTES];

/* An open host-fed batch. */
static struct {
  int open;
  uint8_t chain_id[32], reading_log[20], device_id[32], passport_id[32];
  uint64_t seq, from_ts, to_ts;
  uint32_t expect, got;
  uint8_t leaves[KUTLE_MAX_BATCH][32];
} B;

/* smbus mode: readings the device took itself. */
static kutle_reading_t g_own[KUTLE_MAX_BATCH];
static uint32_t g_own_n;
static uint64_t g_clock_s;    /* unix seconds, 0 until TIME */
static uint32_t g_clock_frac; /* ms carried between ticks */

/* ------------------------------------------------------------- output */

static void line(const char *s) { H->write_line(s); }

static void err(const char *why) {
  char b[96];
  snprintf(b, sizeof b, "ERR %s", why);
  line(b);
}

/* Appends hex of `in` to g_out at position *pos. */
static void put_hex(size_t *pos, const uint8_t *in, size_t len) {
  g_out[(*pos)++] = ' ';
  kutle_hex_encode(in, len, g_out + *pos);
  *pos += 2 * len;
}

static void put_str(size_t *pos, const char *s) {
  size_t n = strlen(s);
  memcpy(g_out + *pos, s, n + 1);
  *pos += n;
}

static void put_u64(size_t *pos, uint64_t v) {
  char b[24];
  snprintf(b, sizeof b, " %" PRIu64, v);
  put_str(pos, b);
}

/* --------------------------------------------------------- parsing */

static int parse_u64(const char *s, uint64_t *out) {
  if (s == NULL || *s == 0) return -1;
  uint64_t v = 0;
  for (; *s; s++) {
    if (*s < '0' || *s > '9') return -1;
    uint64_t d = (uint64_t)(*s - '0');
    if (v > (UINT64_MAX - d) / 10) return -1;
    v = v * 10 + d;
  }
  *out = v;
  return 0;
}

static int hexarg(const char *s, uint8_t *out, size_t len) { return s ? kutle_hex_decode(s, out, len) : -1; }

/* ------------------------------------------------------------ storage */

static void store_u64s(const char *key, uint64_t a, uint64_t b) {
  uint8_t buf[16];
  for (int i = 0; i < 8; i++) {
    buf[i] = (uint8_t)(a >> (56 - 8 * i));
    buf[8 + i] = (uint8_t)(b >> (56 - 8 * i));
  }
  H->store_put(key, buf, sizeof buf);
}

static int load_u64s(const char *key, uint64_t *a, uint64_t *b) {
  uint8_t buf[16];
  if (H->store_get(key, buf, sizeof buf) != (int)sizeof buf) return -1;
  *a = *b = 0;
  for (int i = 0; i < 8; i++) {
    *a = (*a << 8) | buf[i];
    *b = (*b << 8) | buf[8 + i];
  }
  return 0;
}

/* One replay guard per (chainId, readingLog, deviceId), stored under a key
 * derived from that context. */
static void guard_key(const uint8_t chain_id[32], const uint8_t reading_log[20], const uint8_t device_id[32],
                      char key[16]) {
  uint8_t h[32];
  kutle_keccak_ctx c;
  kutle_keccak_init(&c);
  kutle_keccak_update(&c, chain_id, 32);
  kutle_keccak_update(&c, reading_log, 20);
  kutle_keccak_update(&c, device_id, 32);
  kutle_keccak_final(&c, h);
  key[0] = 'g';
  kutle_hex_encode(h, 6, key + 1); /* 13 chars + NUL */
}

/* --------------------------------------------------------------- init */

int kutle_proto_init(const kutle_hal_t *hal) {
  H = hal;
  if (kutle_crypto_init(hal->rng) != 0) return -1;
  int have = H->store_get("ecdsa", K.ecdsa_key, 32) == 32 && H->store_get("xi", K.xi, 32) == 32;
  if (!have) {
    if (kutle_keys_generate(&K) != 0) return -2;
    if (H->store_put("ecdsa", K.ecdsa_key, 32) != 0 || H->store_put("xi", K.xi, 32) != 0) return -3;
    line("# first boot: generated device keys");
  }
  if (kutle_keys_derive(&K) != 0) return -4;
  uint8_t l = 0;
  g_locked = (H->store_get("locked", &l, 1) == 1 && l == 1);
  return 0;
}

uint64_t kutle_proto_now(void) { return g_clock_s; }

void kutle_proto_tick_ms(uint32_t elapsed_ms) {
  if (g_clock_s == 0) return;
  g_clock_frac += elapsed_ms;
  g_clock_s += g_clock_frac / 1000;
  g_clock_frac %= 1000;
}

/* ------------------------------------------------------------ signing */

/* Refuses to go backwards for one context; see SPEC.md section 5. */
static int guard_check(const uint8_t chain_id[32], const uint8_t reading_log[20], const uint8_t device_id[32],
                       uint64_t seq, uint64_t from_ts) {
  char key[16];
  uint64_t hi_seq, hi_to;
  guard_key(chain_id, reading_log, device_id, key);
  if (load_u64s(key, &hi_seq, &hi_to) != 0) return 0;
  if (seq < hi_seq) return -1;
  if (seq > hi_seq && from_ts < hi_to) return -2;
  return 0;
}

static void guard_update(const uint8_t chain_id[32], const uint8_t reading_log[20], const uint8_t device_id[32],
                         uint64_t seq, uint64_t to_ts) {
  char key[16];
  uint64_t hi_seq, hi_to;
  guard_key(chain_id, reading_log, device_id, key);
  if (load_u64s(key, &hi_seq, &hi_to) == 0 && seq < hi_seq) return;
  store_u64s(key, seq, to_ts);
}

static int timed_sign(const uint8_t digest[32]) {
  uint64_t t0 = H->micros ? H->micros() : 0;
  int rc = kutle_sign_digest(&K, digest, g_ecdsa, g_mldsa);
  if (H->micros) {
    char b[80];
    snprintf(b, sizeof b, "# hybrid sign took %" PRIu64 " us", H->micros() - t0);
    line(b);
  }
  return rc;
}

/* Root, digest, signatures and the OK BATCH line for leaves already in B. */
static void finish_batch(uint32_t count) {
  uint8_t root[32], digest[32];
  int g = guard_check(B.chain_id, B.reading_log, B.device_id, B.seq, B.from_ts);
  if (g == -1) return err("stale-seq");
  if (g == -2) return err("window-regress");
  kutle_merkle_root(B.leaves, count, root);
  kutle_batch_digest(B.chain_id, B.reading_log, B.device_id, B.passport_id, B.seq, root, B.from_ts, B.to_ts, count,
                     digest);
  if (timed_sign(digest) != 0) return err("sign-failed");
  guard_update(B.chain_id, B.reading_log, B.device_id, B.seq, B.to_ts);
  size_t p = 0;
  put_str(&p, "OK BATCH");
  put_hex(&p, root, 32);
  put_u64(&p, B.from_ts);
  put_u64(&p, B.to_ts);
  put_u64(&p, count);
  put_hex(&p, digest, 32);
  put_hex(&p, g_ecdsa, sizeof g_ecdsa);
  put_hex(&p, g_mldsa, sizeof g_mldsa);
  line(g_out);
}

/* Shared header of BATCH and OWNBATCH: chainId readingLog deviceId passportId seq */
static int parse_header(char **a) {
  if (hexarg(a[1], B.chain_id, 32) || hexarg(a[2], B.reading_log, 20) || hexarg(a[3], B.device_id, 32) ||
      hexarg(a[4], B.passport_id, 32) || parse_u64(a[5], &B.seq))
    return -1;
  return 0;
}

/* ----------------------------------------------------------- commands */

static void cmd_batch(char **a, int n) {
  uint64_t count;
  memset(&B, 0, sizeof B);
  if (n != 7 || parse_header(a) || parse_u64(a[6], &count)) return err("usage");
  if (count == 0 || count > KUTLE_MAX_BATCH) return err("count");
  B.open = 1;
  B.expect = (uint32_t)count;
  char b[32];
  snprintf(b, sizeof b, "OK SEND %" PRIu32, B.expect);
  line(b);
}

static void cmd_reading(char **a, int n) {
  uint8_t wire[KUTLE_WIRE_BYTES];
  kutle_reading_t r;
  if (!B.open) return err("no-batch");
  if (n != 2 || hexarg(a[1], wire, sizeof wire) || kutle_reading_from_wire(wire, &r)) {
    B.open = 0;
    return err("bad-reading");
  }
  if (B.got > 0 && r.timestamp < B.to_ts) {
    B.open = 0;
    return err("out-of-order");
  }
  if (B.got == 0) B.from_ts = r.timestamp;
  B.to_ts = r.timestamp;
  /* The device hashes the raw values itself; the host never sends a leaf. */
  kutle_reading_leaf(&r, B.leaves[B.got]);
  char b[32];
  snprintf(b, sizeof b, "OK R %" PRIu32, B.got);
  line(b);
  if (++B.got == B.expect) {
    B.open = 0;
    finish_batch(B.expect);
  }
}

static void cmd_own_batch(char **a, int n) {
  uint8_t wire[KUTLE_WIRE_BYTES];
  char b[8 + 2 * KUTLE_WIRE_BYTES];
  memset(&B, 0, sizeof B);
  if (H->gauge_read == NULL) return err("not-smbus");
  if (n != 6 || parse_header(a)) return err("usage");
  if (g_own_n == 0) return err("empty");
  for (uint32_t i = 0; i < g_own_n; i++) {
    kutle_reading_leaf(&g_own[i], B.leaves[i]);
    kutle_reading_to_wire(&g_own[i], wire);
    strcpy(b, "OK R ");
    kutle_hex_encode(wire, sizeof wire, b + 5);
    line(b);
  }
  B.from_ts = g_own[0].timestamp;
  B.to_ts = g_own[g_own_n - 1].timestamp;
  finish_batch(g_own_n);
}

int kutle_proto_sample(void) {
  kutle_reading_t r;
  if (H->gauge_read == NULL) return -1;
  if (g_clock_s == 0) return -2;
  if (g_own_n == KUTLE_MAX_BATCH) return -3;
  memset(&r, 0, sizeof r);
  if (H->gauge_read(&r) != 0) return -4;
  r.timestamp = g_clock_s;
  g_own[g_own_n++] = r;
  return 0;
}

static void cmd_sample(void) {
  uint8_t wire[KUTLE_WIRE_BYTES];
  char b[8 + 2 * KUTLE_WIRE_BYTES];
  int rc = kutle_proto_sample();
  if (rc == -1) return err("not-smbus");
  if (rc == -2) return err("no-time");
  if (rc == -3) return err("buffer-full");
  if (rc != 0) return err("gauge");
  kutle_reading_to_wire(&g_own[g_own_n - 1], wire);
  strcpy(b, "OK R ");
  kutle_hex_encode(wire, sizeof wire, b + 5);
  line(b);
}

static void cmd_clear(char **a, int n) {
  uint64_t c;
  char b[32];
  if (n != 2 || parse_u64(a[1], &c)) return err("usage");
  if (c > g_own_n) c = g_own_n;
  memmove(g_own, g_own + c, (g_own_n - c) * sizeof g_own[0]);
  g_own_n -= (uint32_t)c;
  snprintf(b, sizeof b, "OK CLEAR %" PRIu32, g_own_n);
  line(b);
}

static void cmd_pop(char **a, int n) {
  uint8_t chain_id[32], registry[20], device_id[32], digest[32];
  uint64_t version;
  if (n != 5 || hexarg(a[1], chain_id, 32) || hexarg(a[2], registry, 20) || hexarg(a[3], device_id, 32) ||
      parse_u64(a[4], &version) || version == 0 || version > UINT32_MAX)
    return err("usage");
  /* Signer and pkHash are the device's own; the host cannot choose them. */
  kutle_pop_digest(chain_id, registry, device_id, (uint32_t)version, K.address, K.pk_hash, digest);
  if (timed_sign(digest) != 0) return err("sign-failed");
  size_t p = 0;
  put_str(&p, "OK SIG");
  put_hex(&p, digest, 32);
  put_hex(&p, g_ecdsa, sizeof g_ecdsa);
  put_hex(&p, g_mldsa, sizeof g_mldsa);
  line(g_out);
}

static void cmd_wrap(char **a, int n) {
  uint8_t S[33], e[32], E[33], ct[32], tag[32];
  if (g_locked) return err("locked");
  if (n != 2 || hexarg(a[1], S, 33)) return err("usage");
  if (H->rng(e, 32) != 0) return err("rng");
  int rc = kutle_wrap_seed(&K, S, e, E, ct, tag);
  kutle_wipe(e, sizeof e);
  if (rc != 0) return err("wrap");
  size_t p = 0;
  put_str(&p, "OK WRAP");
  put_hex(&p, E, 33);
  put_hex(&p, ct, 32);
  put_hex(&p, tag, 32);
  line(g_out);
}

static void cmd_bench(char **a, int n) {
  uint64_t iters = 5, sum = 0, mn = UINT64_MAX, mx = 0;
  uint8_t digest[32] = {0};
  if (n == 2 && parse_u64(a[1], &iters)) return err("usage");
  if (H->micros == NULL) return err("no-timer");
  if (iters == 0 || iters > 100) return err("count");
  for (uint64_t i = 0; i < iters; i++) {
    digest[0] = (uint8_t)i;
    uint64_t t0 = H->micros();
    if (kutle_mldsa_sign_digest(&K, digest, g_mldsa) != 0) return err("sign-failed");
    uint64_t dt = H->micros() - t0;
    sum += dt;
    if (dt < mn) mn = dt;
    if (dt > mx) mx = dt;
  }
  char b[128];
  snprintf(b, sizeof b, "OK BENCH mldsa44-sign n=%" PRIu64 " avg_us=%" PRIu64 " min_us=%" PRIu64 " max_us=%" PRIu64
           " stack_free=%" PRIu32,
           iters, sum / iters, mn, mx, H->stack_free ? H->stack_free() : 0);
  line(b);
}

void kutle_proto_line(char *ln) {
  char *a[10];
  int n = 0;
  for (char *t = strtok(ln, " \r\t"); t && n < 10; t = strtok(NULL, " \r\t")) a[n++] = t;
  if (n == 0) return;
  char b[160];

  if (B.open && strcmp(a[0], "R") != 0) {
    B.open = 0;
    line("# open batch abandoned");
  }

  if (!strcmp(a[0], "PING")) {
    snprintf(b, sizeof b, "OK PONG %s %s", H->firmware, H->mode);
    line(b);
  } else if (!strcmp(a[0], "ID")) {
    size_t p = 0;
    put_str(&p, "OK ID");
    put_hex(&p, K.address, 20);
    put_hex(&p, K.pk_hash, 32);
    put_hex(&p, K.commitment, 32);
    put_str(&p, g_locked ? " 1" : " 0");
    line(g_out);
  } else if (!strcmp(a[0], "PK")) {
    size_t p = 0;
    put_str(&p, "OK PK");
    put_hex(&p, K.pk, sizeof K.pk);
    line(g_out);
  } else if (!strcmp(a[0], "WRAP")) {
    cmd_wrap(a, n);
  } else if (!strcmp(a[0], "LOCK")) {
    uint8_t one = 1;
    if (H->store_put("locked", &one, 1) != 0) return err("store");
    g_locked = 1;
    line("OK LOCKED");
  } else if (!strcmp(a[0], "POP")) {
    cmd_pop(a, n);
  } else if (!strcmp(a[0], "BATCH")) {
    cmd_batch(a, n);
  } else if (!strcmp(a[0], "R")) {
    cmd_reading(a, n);
  } else if (!strcmp(a[0], "TIME")) {
    uint64_t t;
    if (n != 2 || parse_u64(a[1], &t)) return err("usage");
    g_clock_s = t;
    g_clock_frac = 0;
    line("OK TIME");
  } else if (!strcmp(a[0], "SAMPLE")) {
    cmd_sample();
  } else if (!strcmp(a[0], "OWNBATCH")) {
    cmd_own_batch(a, n);
  } else if (!strcmp(a[0], "CLEAR")) {
    cmd_clear(a, n);
  } else if (!strcmp(a[0], "BENCH")) {
    cmd_bench(a, n);
  } else {
    err("unknown-command");
  }
}
