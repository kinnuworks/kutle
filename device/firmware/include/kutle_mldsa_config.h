/* mldsa-native build configuration for the Kütle firmware (ML-DSA-44 only).
 * Selected with -DMLD_CONFIG_FILE="kutle_mldsa_config.h" in platformio.ini and
 * sim/Makefile so the library and its callers agree on the namespace. */
#ifndef MLD_CONFIG_H
#define MLD_CONFIG_H

#define MLD_CONFIG_PARAMETER_SET 44
#define MLD_CONFIG_NAMESPACE_PREFIX kutle_mldsa

/* Portable C arithmetic: no native backend is enabled, so nothing
 * architecture-specific is compiled. Inline asm stays available because
 * mldsa-native uses empty asm statements as value and zeroization barriers. */

/* Trade speed for RAM: about 13 KB of working memory for signing instead of
 * about 45 KB (MLD_TOTAL_ALLOC_44_SIGN in mldsa_native.h). The ESP32-S3 build
 * sets this; the host builds leave it off. */
#if defined(KUTLE_MLDSA_REDUCE_RAM)
#define MLD_CONFIG_REDUCE_RAM
#endif

#endif /* MLD_CONFIG_H */
