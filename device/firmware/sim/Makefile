# Host build of the firmware protocol and crypto, for the gateway's edge-mode
# tests and the end-to-end run. Same sources and flags as the ESP32-S3 build
# except the HAL.

LIB    := ../lib
MLDSA  := $(LIB)/mldsa-native/mldsa
SECP   := $(LIB)/secp256k1
OUT    := build
CC     ?= cc

COMMON := -O2 -I$(LIB)/kutle_core/src -I$(LIB)/kutle_device/src -I../include -I$(MLDSA) -I$(SECP)/include \
          -DMLD_CONFIG_FILE='"kutle_mldsa_config.h"'
SECPFLAGS := -DENABLE_MODULE_RECOVERY=1 -DENABLE_MODULE_ECDH=1 -DECMULT_WINDOW_SIZE=4 -DCOMB_BLOCKS=2 -DCOMB_TEETH=5 \
          -Wno-unused-function

OBJS := $(OUT)/kutle_core.o $(OUT)/kutle_keccak.o $(OUT)/kutle_keys.o $(OUT)/kutle_proto.o \
        $(OUT)/mldsa_native.o $(OUT)/secp256k1.o $(OUT)/precomputed_ecmult.o $(OUT)/precomputed_ecmult_gen.o

all: $(OUT)/kutle-sim

$(OUT):
	mkdir -p $(OUT)

$(OUT)/kutle_core.o: $(LIB)/kutle_core/src/kutle_core.c | $(OUT)
	$(CC) $(COMMON) -std=c11 -Wall -Wextra -c $< -o $@
$(OUT)/kutle_keccak.o: $(LIB)/kutle_core/src/kutle_keccak.c | $(OUT)
	$(CC) $(COMMON) -std=c11 -Wall -Wextra -c $< -o $@
$(OUT)/kutle_keys.o: $(LIB)/kutle_device/src/kutle_keys.c | $(OUT)
	$(CC) $(COMMON) -std=c11 -Wall -Wextra -c $< -o $@
$(OUT)/kutle_proto.o: $(LIB)/kutle_device/src/kutle_proto.c | $(OUT)
	$(CC) $(COMMON) -std=c11 -Wall -Wextra -c $< -o $@
$(OUT)/mldsa_native.o: $(MLDSA)/mldsa_native.c | $(OUT)
	$(CC) $(COMMON) -std=c99 -c $< -o $@
$(OUT)/secp256k1.o: $(SECP)/src/secp256k1.c | $(OUT)
	$(CC) $(COMMON) $(SECPFLAGS) -c $< -o $@
$(OUT)/precomputed_ecmult.o: $(SECP)/src/precomputed_ecmult.c | $(OUT)
	$(CC) $(COMMON) $(SECPFLAGS) -c $< -o $@
$(OUT)/precomputed_ecmult_gen.o: $(SECP)/src/precomputed_ecmult_gen.c | $(OUT)
	$(CC) $(COMMON) $(SECPFLAGS) -c $< -o $@

$(OUT)/kutle-sim: sim_main.c $(OBJS)
	$(CC) $(COMMON) -std=c11 -Wall -Wextra $^ -o $@

clean:
	rm -rf $(OUT)

.PHONY: all clean
