/* Host build of the device protocol. It runs exactly the firmware's protocol
 * and crypto code (lib/kutle_core, lib/kutle_device, mldsa-native,
 * libsecp256k1) over stdin/stdout, with files standing in for NVS. The gateway
 * talks to it with KUTLE_DEVICE="sim:firmware/sim/build/kutle-sim <state-dir>".
 *
 *   kutle-sim <state-dir> [--smbus-fake]
 *
 * --smbus-fake replaces the SMBus gauge with a synthetic one so the smbus-mode
 * commands can be exercised on a computer. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>

#include "kutle_proto.h"

static const char *g_dir;
static unsigned g_fake_n;

static int sim_rng(uint8_t *out, size_t len) {
  FILE *f = fopen("/dev/urandom", "rb");
  if (!f) return -1;
  size_t n = fread(out, 1, len, f);
  fclose(f);
  return n == len ? 0 : -1;
}

static void path_for(const char *key, char *buf, size_t n) { snprintf(buf, n, "%s/%s.bin", g_dir, key); }

static int sim_get(const char *key, uint8_t *buf, size_t len) {
  char p[1024];
  path_for(key, p, sizeof p);
  FILE *f = fopen(p, "rb");
  if (!f) return -1;
  size_t n = fread(buf, 1, len, f);
  fclose(f);
  return (int)n;
}

static int sim_put(const char *key, const uint8_t *buf, size_t len) {
  char p[1024];
  path_for(key, p, sizeof p);
  FILE *f = fopen(p, "wb");
  if (!f) return -1;
  size_t n = fwrite(buf, 1, len, f);
  fclose(f);
  return n == len ? 0 : -1;
}

static void sim_write(const char *line) {
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static uint64_t sim_micros(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (uint64_t)tv.tv_sec * 1000000u + (uint64_t)tv.tv_usec;
}

static int fake_gauge(kutle_reading_t *r) {
  unsigned i = g_fake_n++;
  r->cycle_count = 170;
  r->design_capacity_mah = 4629;
  r->full_charge_capacity_mah = 4393;
  r->pack_voltage_mv = 11500 + (i % 50);
  r->current_ma = -500 - (int32_t)(i % 7);
  r->temperature_centic = kutle_decikelvin_to_centic(3034);
  r->soc_pct = 50;
  for (int c = 0; c < 3; c++) {
    r->cell_voltage_mv[c] = (uint16_t)(3830 + c + (i % 5));
    r->cell_qmax_mah[c] = (uint16_t)(4800 + c);
    r->cell_resistance[c] = (uint16_t)(55 + c);
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <state-dir> [--smbus-fake]\n", argv[0]);
    return 2;
  }
  g_dir = argv[1];
  mkdir(g_dir, 0700);
  int smbus = argc > 2 && strcmp(argv[2], "--smbus-fake") == 0;
  static kutle_hal_t hal;
  hal.firmware = "kutle-fw/1.0.0-sim";
  hal.mode = smbus ? "smbus" : "host-fed";
  hal.rng = sim_rng;
  hal.store_get = sim_get;
  hal.store_put = sim_put;
  hal.write_line = sim_write;
  hal.gauge_read = smbus ? fake_gauge : NULL;
  hal.micros = sim_micros;
  if (kutle_proto_init(&hal) != 0) {
    sim_write("# init failed");
    return 1;
  }
  char *ln = NULL;
  size_t cap = 0;
  ssize_t n;
  while ((n = getline(&ln, &cap, stdin)) > 0) {
    while (n > 0 && (ln[n - 1] == '\n' || ln[n - 1] == '\r')) ln[--n] = 0;
    kutle_proto_line(ln);
  }
  free(ln);
  return 0;
}
