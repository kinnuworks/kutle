# Reading record, Merkle tree and device protocol

Version 1. This document is normative for three implementations that must agree
byte for byte:

- the gateway, in TypeScript (`device/lib/reading.ts`, `device/lib/merkle.ts`,
  `device/lib/digest.ts`);
- the firmware, in C (`device/firmware/lib/kutle_core/`);
- the contracts, which only see the Merkle root and the proof path
  (`contracts/src/ReadingLog.sol`).

`device/test-vectors.json` is generated from the TypeScript implementation by
`node scripts/gen-vectors.ts` and checked by both the gateway tests and the
firmware's native test build. A change to anything below changes the vectors.

## 1. Reading record

One reading is one snapshot of a smart-battery gauge (TI bq40z651 or any SBS 1.1
gauge). Fields, in this order:

| # | Field | Solidity type | Unit | SBS source | macOS ioreg source |
|---|---|---|---|---|---|
| 1 | `timestamp` | `uint64` | unix seconds, UTC | device clock | gateway clock |
| 2 | `cycleCount` | `uint32` | cycles | 0x17 CycleCount | `CycleCount` |
| 3 | `designCapacity_mAh` | `uint32` | mAh | 0x18 DesignCapacity | `DesignCapacity` |
| 4 | `fullChargeCapacity_mAh` | `uint32` | mAh | 0x10 FullChargeCapacity | `AppleRawMaxCapacity` |
| 5 | `packVoltage_mV` | `uint32` | mV | 0x09 Voltage | `Voltage` |
| 6 | `current_mA` | `int32` | mA, positive while charging | 0x0A Current | `InstantAmperage`, else `Amperage` |
| 7 | `temperature_centiC` | `int16` | 0.01 degC | 0x08 Temperature (0.1 K) | `Temperature` |
| 8 | `stateOfCharge_pct` | `uint8` | percent, 0 to 100 | 0x0D RelativeStateOfCharge | `BatteryData.StateOfCharge`, else `CurrentCapacity` |
| 9 | `cellVoltage_mV` | `uint16[3]` | mV per cell | 0x3F, 0x3E, 0x3D (cell 1, 2, 3) | `BatteryData.CellVoltage` |
| 10 | `cellQmax_mAh` | `uint16[3]` | mAh per cell | gauge-specific, see firmware README | `BatteryData.Qmax` |
| 11 | `cellResistance` | `uint16[3]` | gauge units (WeightedRa) | gauge-specific, see firmware README | `BatteryData.WeightedRa` |

Rules:

- SBS temperature conversion: `temperature_centiC = deciKelvin * 10 - 27315`.
- Cell arrays always have exactly three entries. A pack with fewer series cells
  fills the unused entries with 0. A value the source cannot provide is 0.
- ioreg reports negative currents as 64-bit two's complement integers
  (for example 18446744073709551143); they are reinterpreted as signed.
- A reading whose fields fall outside their type's range is rejected; nothing
  is clamped or truncated silently.

### 1.1 Hashing encoding

The record is hashed in its Solidity ABI encoding:

```
enc  = abi.encode(uint64 timestamp, uint32 cycleCount, uint32 designCapacity_mAh,
                  uint32 fullChargeCapacity_mAh, uint32 packVoltage_mV,
                  int32 current_mA, int16 temperature_centiC, uint8 stateOfCharge_pct,
                  uint16[3] cellVoltage_mV, uint16[3] cellQmax_mAh, uint16[3] cellResistance)
leaf = keccak256(bytes.concat(keccak256(enc)))
```

`enc` is 17 words (544 bytes): eight scalar words followed by the three fixed
arrays inline, three words each. Unsigned values are left-padded with zero
bytes; signed values are sign-extended to 32 bytes.

The leaf is hashed twice so that a leaf is a hash of 32 bytes and an internal
node is a hash of 64 bytes. A 64-byte internal-node preimage can therefore never
be presented as a leaf, and the 544-byte record can never be presented as an
internal node.

### 1.2 Wire encoding

Between the gateway and the device, and in the gateway's local store, a reading
travels in a compact form: the same fields in the same order, each big-endian,
at its natural width, with no padding.

| Field | Bytes |
|---|---|
| timestamp | 8 |
| cycleCount, designCapacity, fullChargeCapacity, packVoltage | 4 each |
| current_mA | 4 (two's complement) |
| temperature_centiC | 2 (two's complement) |
| stateOfCharge_pct | 1 |
| cellVoltage_mV[0..2], cellQmax_mAh[0..2], cellResistance[0..2] | 2 each |

Total: 49 bytes, sent as 98 lowercase hex characters. The wire encoding is never
hashed; the receiver decodes it and hashes the ABI encoding.

## 2. Merkle tree

Input: the leaves of one batch, in the order the readings were taken (timestamps
non-decreasing). A batch has at least one leaf.

```
level0 = leaves
while len(level) > 1:
    next = []
    for i in 0, 2, 4, ...:
        if i + 1 < len(level):
            a, b = level[i], level[i + 1]
            next.append(keccak256(min(a, b) || max(a, b)))   # 32-byte big-endian compare
        else:
            next.append(level[i])                            # odd node carried up unchanged
    level = next
root = level[0]
```

A tree of one leaf has `root = leaf`. The proof for a leaf lists, bottom up, the
sibling at every level where the node has one; a level where the node is carried
up contributes nothing. This is exactly what `ReadingLog.verifyReading(batchId,
leaf, proof)` folds:

```
h = leaf
for p in proof: h = keccak256(min(h, p) || max(h, p))
return h == root
```

Because pairs are sorted, a proof does not carry left/right flags. The tree is
not a commitment to the order of the readings; the order and the window are
covered by `fromTs`, `toTs` and `count` in the signed batch digest.

## 3. Signed digests

Both digests are restated from the contracts and must match them byte for byte.

Batch (ReadingLog.batchDigest):

```
BATCH_TYPEHASH = keccak256("KutleReadingBatch(bytes32 deviceId,uint256 passportId,uint64 seq,bytes32 root,uint64 fromTs,uint64 toTs,uint32 count)")
digest = keccak256(abi.encode(BATCH_TYPEHASH, chainId, readingLog, deviceId,
                              passportId, uint64 seq, root, uint64 fromTs,
                              uint64 toTs, uint32 count))
```

with `fromTs` the first reading's timestamp, `toTs` the last one's and `count`
the number of leaves.

Proof of possession (DeviceRegistry.popDigest):

```
digest = keccak256(abi.encode(keccak256("KUTLE_DEVICE_POP_V1"), chainId, registry,
                              deviceId, uint32 version, address ecdsaSigner,
                              bytes32 pkHash))
```

with `pkHash = keccak256(pk)` over the canonical 1,312-byte FIPS 204 key.

Each digest is signed twice:

- ECDSA secp256k1 over `keccak256("\x19Ethereum Signed Message:\n32" || digest)`
  (EIP-191 personal_sign), encoded as `r || s || v`, 65 bytes, low s,
  `v` in {27, 28};
- ML-DSA-44, FIPS 204 ML-DSA.Sign with an empty context string over the raw
  32 bytes of `digest`, 2,420 bytes. Hedged (randomised) signing is used; the
  verifier does not care.

## 4. Device keys

A device holds two independent 32-byte secrets, generated by its hardware RNG on
first boot:

- `ecdsaKey`, a secp256k1 private key (regenerated until it is a valid scalar);
- `xi`, the ML-DSA-44 KeyGen seed (FIPS 204 Algorithm 6 input). The ML-DSA key
  pair is always re-derived from `xi`; the expanded secret key is never stored.

Seed commitment, published at provisioning and recorded by the station:

```
commitment = keccak256("KUTLE_SEED_COMMIT_V1" || xi)
```

### 4.1 Seed export to the provisioning station

The station must re-run KeyGen on `xi` (SAFETY.md 3.1 (2)(ii)), so `xi` travels
once, encrypted to a fresh station key, before the device is locked:

```
station:  s <- random scalar, S = s*G (33-byte compressed), sends S
device:   e <- random scalar, E = e*G (33-byte compressed)
          z      = sha256(compressed(e*S))          # libsecp256k1 default ECDH hash
          info   = "KUTLE_SEED_WRAP_V1" || E || S || deviceAddress(20)
          kEnc   = keccak256(0x01 || z || info)
          kMac   = keccak256(0x02 || z || info)
          ct     = xi XOR kEnc
          tag    = keccak256(kMac || ct)
          replies E, ct, tag
station:  z = sha256(compressed(s*E)), recompute kEnc, kMac, check tag,
          xi = ct XOR kEnc, check keccak256("KUTLE_SEED_COMMIT_V1" || xi) == commitment,
          check pkEncode(KeyGen(xi)) == the key the device reported, byte for byte
```

Keccak-256 is a sponge, so `keccak256(key || message)` is a sound MAC without
HMAC's nesting. After a successful registration the station sends `LOCK`, after
which the device refuses to export its seed again.

## 5. Gateway to device protocol

Line based ASCII over USB CDC serial, 115200 8N1 (the baud rate is ignored by
the ESP32-S3 USB peripheral). Every line ends with `\n`. Hex is lowercase
without `0x`. Every command gets exactly one final reply line starting with
`OK ` or `ERR `. Lines starting with `#` are diagnostics and are ignored by the
host.

| Command | Reply |
|---|---|
| `PING` | `OK PONG <firmware> <mode>`, mode is `host-fed` or `smbus` |
| `ID` | `OK ID <address 40> <pkHash 64> <commitment 64> <locked 0/1>` |
| `PK` | `OK PK <pk 2624>` |
| `WRAP <S 66>` | `OK WRAP <E 66> <ct 64> <tag 64>`; `ERR locked` once locked |
| `LOCK` | `OK LOCKED` |
| `POP <chainId 64> <registry 40> <deviceId 64> <version decimal>` | `OK SIG <digest 64> <ecdsa 130> <mldsa 4840>` |
| `BATCH <chainId 64> <readingLog 40> <deviceId 64> <passportId 64> <seq decimal> <count decimal>` | `OK SEND <count>`, then the host sends `count` lines `R <wire 98>`, each answered by `OK R <index>`, then `OK BATCH <root 64> <fromTs> <toTs> <count> <digest 64> <ecdsa 130> <mldsa 4840>` |
| `TIME <unix decimal>` | `OK TIME`; sets the device clock (smbus mode) |
| `SAMPLE` | smbus mode: reads the gauge, appends to the device buffer, `OK R <wire 98>` |
| `OWNBATCH <chainId 64> <readingLog 40> <deviceId 64> <passportId 64> <seq decimal>` | smbus mode: signs the device's own buffered readings; streams one `OK R <wire 98>` line per reading, then the `OK BATCH ...` line |
| `CLEAR <count decimal>` | smbus mode: drops the first `count` buffered readings, `OK CLEAR <remaining>` |

The device computes `pkHash`, its own address, every leaf, the root, `fromTs`,
`toTs`, `count` and the digest itself. The host never supplies a digest, so the
device is not a signing oracle for arbitrary 32-byte values. In `host-fed` mode
the device still has to trust the host for the reading values; in `smbus` mode
it reads them from the gauge itself.

A batch holds 1 to 256 readings (`KUTLE_MAX_BATCH`, the gateway's
`MAX_BATCH`).

The device keeps the highest `seq` it has signed and that batch's `toTs` in
non-volatile storage. It refuses a batch with a lower `seq`, and a batch with a
higher `seq` whose `fromTs` is earlier than the stored `toTs`. Re-signing the
same `seq` is allowed so a failed transaction can be retried.
