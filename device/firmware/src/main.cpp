// Kütle battery-side device firmware for the ESP32-S3 (Arduino core on
// ESP-IDF). The protocol and crypto live in lib/kutle_device and
// lib/kutle_core; this file is the hardware layer: USB CDC serial, NVS, the
// hardware RNG and the SMBus link to the fuel gauge.

#include <Arduino.h>
#include <Preferences.h>
#include <Wire.h>
#include <bootloader_random.h>
#include <esp_random.h>
#include <esp_timer.h>

extern "C" {
#include "kutle_proto.h"
}

// ML-DSA-44 signing needs about 13 KB of working memory with
// MLD_CONFIG_REDUCE_RAM (more without it) plus our own frames; the default
// 8 KB Arduino loop task is too small. See README.md for the numbers.
SET_LOOP_TASK_STACK_SIZE(64 * 1024);

#ifndef KUTLE_MODE_SMBUS
#define KUTLE_MODE_SMBUS 0
#endif
#ifndef KUTLE_SMBUS_SDA
#define KUTLE_SMBUS_SDA 8
#endif
#ifndef KUTLE_SMBUS_SCL
#define KUTLE_SMBUS_SCL 9
#endif
#ifndef KUTLE_SMBUS_HZ
#define KUTLE_SMBUS_HZ 100000
#endif
#ifndef KUTLE_SAMPLE_INTERVAL_MS
#define KUTLE_SAMPLE_INTERVAL_MS 60000
#endif

static const uint8_t GAUGE_ADDR = 0x0B;  // SBS smart battery address

static Preferences prefs;
static kutle_hal_t hal;

// ----------------------------------------------------------------- HAL

static int hal_rng(uint8_t *out, size_t len) {
  // With RF off, the RNG is only a true RNG while the bootloader entropy
  // source is enabled (ESP-IDF "Random Number Generation"). Enable it around
  // every draw; key generation and hedged signing both come through here.
  bootloader_random_enable();
  esp_fill_random(out, len);
  bootloader_random_disable();
  return 0;
}

static int hal_get(const char *key, uint8_t *buf, size_t len) {
  if (!prefs.isKey(key)) return -1;
  return (int)prefs.getBytes(key, buf, len);
}

static int hal_put(const char *key, const uint8_t *buf, size_t len) {
  return prefs.putBytes(key, buf, len) == len ? 0 : -1;
}

static void hal_write(const char *line) {
  Serial.write(line);
  Serial.write('\n');
  Serial.flush();
}

static uint64_t hal_micros(void) { return (uint64_t)esp_timer_get_time(); }

static uint32_t hal_stack_free(void) {
  // ESP-IDF's FreeRTOS reports the high-water mark in bytes.
  return (uint32_t)uxTaskGetStackHighWaterMark(NULL);
}

// --------------------------------------------------------------- SMBus

static bool sbs_word(uint8_t cmd, uint16_t *out) {
  Wire.beginTransmission(GAUGE_ADDR);
  Wire.write(cmd);
  if (Wire.endTransmission(false) != 0) return false;  // repeated start
  if (Wire.requestFrom(GAUGE_ADDR, (uint8_t)2) != 2) return false;
  uint8_t lo = Wire.read(), hi = Wire.read();
  *out = (uint16_t)(lo | (hi << 8));
  return true;
}

#if defined(KUTLE_BQ_MAC_QMAX)
// ManufacturerBlockAccess (0x44): write the 16-bit subcommand, read the block
// back as [len][sub lo][sub hi][data...]. KUTLE_BQ_MAC_QMAX is the subcommand
// whose payload starts with QMax cell 1..3 as little-endian words. Confirm the
// subcommand against the bq40z651 technical reference manual before enabling.
static bool bq_mac_block(uint16_t sub, uint8_t *data, size_t n) {
  Wire.beginTransmission(GAUGE_ADDR);
  Wire.write(0x44);
  Wire.write(2);
  Wire.write((uint8_t)sub);
  Wire.write((uint8_t)(sub >> 8));
  if (Wire.endTransmission() != 0) return false;
  delay(2);
  Wire.beginTransmission(GAUGE_ADDR);
  Wire.write(0x44);
  if (Wire.endTransmission(false) != 0) return false;
  size_t want = n + 3;
  if (Wire.requestFrom(GAUGE_ADDR, (uint8_t)want) != want) return false;
  uint8_t len = Wire.read();
  uint16_t echo = Wire.read();
  echo |= (uint16_t)Wire.read() << 8;
  if (echo != sub || len < n + 2) return false;
  for (size_t i = 0; i < n; i++) data[i] = Wire.read();
  return true;
}
#endif

static int hal_gauge(kutle_reading_t *r) {
  uint16_t t, v, c, soc, fcc, cyc, dc, c1, c2, c3;
  // Standard SBS 1.1 commands, all 16-bit words.
  if (!sbs_word(0x08, &t) || !sbs_word(0x09, &v) || !sbs_word(0x0A, &c) || !sbs_word(0x0D, &soc) ||
      !sbs_word(0x10, &fcc) || !sbs_word(0x17, &cyc) || !sbs_word(0x18, &dc) || !sbs_word(0x3F, &c1) ||
      !sbs_word(0x3E, &c2) || !sbs_word(0x3D, &c3))
    return -1;
  if (soc > 100) return -2;
  r->temperature_centic = kutle_decikelvin_to_centic(t);
  r->pack_voltage_mv = v;
  r->current_ma = (int16_t)c;  // SBS Current is signed, positive while charging
  r->soc_pct = (uint8_t)soc;
  r->full_charge_capacity_mah = fcc;
  r->cycle_count = cyc;
  r->design_capacity_mah = dc;
  r->cell_voltage_mv[0] = c1;
  r->cell_voltage_mv[1] = c2;
  r->cell_voltage_mv[2] = c3;
#if defined(KUTLE_BQ_MAC_QMAX)
  uint8_t q[6];
  if (bq_mac_block(KUTLE_BQ_MAC_QMAX, q, sizeof q)) {
    for (int i = 0; i < 3; i++) r->cell_qmax_mah[i] = (uint16_t)(q[2 * i] | (q[2 * i + 1] << 8));
  }
#endif
  // cellResistance (WeightedRa) has no standard SBS command and stays 0 here.
  return 0;
}

// ------------------------------------------------------------ Arduino

static char rx[640];
static size_t rx_len;
static uint32_t last_tick, last_sample;

void setup() {
  Serial.setRxBufferSize(1024);
  Serial.begin(115200);
  prefs.begin("kutle", false);

  hal.firmware = "kutle-fw/1.0.0";
  hal.mode = KUTLE_MODE_SMBUS ? "smbus" : "host-fed";
  hal.rng = hal_rng;
  hal.store_get = hal_get;
  hal.store_put = hal_put;
  hal.write_line = hal_write;
  hal.gauge_read = KUTLE_MODE_SMBUS ? hal_gauge : NULL;
  hal.micros = hal_micros;
  hal.stack_free = hal_stack_free;

  if (KUTLE_MODE_SMBUS) Wire.begin(KUTLE_SMBUS_SDA, KUTLE_SMBUS_SCL, KUTLE_SMBUS_HZ);

  uint64_t t0 = esp_timer_get_time();
  int rc = kutle_proto_init(&hal);
  char b[96];
  snprintf(b, sizeof b, "# kutle-fw init rc=%d in %llu us, mode=%s", rc,
           (unsigned long long)(esp_timer_get_time() - t0), hal.mode);
  hal_write(b);
  last_tick = last_sample = millis();
}

void loop() {
  while (Serial.available() > 0) {
    int ch = Serial.read();
    if (ch == '\n') {
      rx[rx_len] = 0;
      kutle_proto_line(rx);
      rx_len = 0;
    } else if (ch != '\r') {
      if (rx_len < sizeof rx - 1) rx[rx_len++] = (char)ch;
      else rx_len = 0;  // overlong line: drop it, the host will see no reply and time out
    }
  }
  uint32_t now = millis();
  kutle_proto_tick_ms(now - last_tick);
  last_tick = now;
  if (KUTLE_MODE_SMBUS && kutle_proto_now() != 0 && now - last_sample >= KUTLE_SAMPLE_INTERVAL_MS) {
    last_sample = now;
    if (kutle_proto_sample() != 0) hal_write("# sample failed");
  }
  delay(1);
}
