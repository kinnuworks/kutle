# Provisioning station and key ceremony

The provisioning station turns a freshly flashed device into a registered one.
It runs `node provision/src/cli.ts` on an offline-capable computer that holds
the registrar key (`REGISTRAR_ROLE` on `DeviceRegistry`).

## What gets checked, and where

| Check | Where | Why |
|---|---|---|
| KeyGen-seed binding: `pkEncode(KeyGen(xi))` equals the reported key byte for byte | station | The only complete defence against degenerate ML-DSA keys (SAFETY.md 3.1 (2)(ii)) |
| Seed commitment matches `keccak256("KUTLE_SEED_COMMIT_V1" \|\| xi)` | station | Ties the seed that was checked to the device that reported it |
| Centred-lift floor, at least 512 of 1024 t1 coefficients large | station, then again in `MLDSAKey.sol` | A floor to refuse beneath; also stops a bad key before it costs gas |
| Deployed blob equals `prepare(pk)` byte for byte | station | SAFETY.md 3.1 (1); the registry only checks the blob's size and pins its code hash |
| `popDigest` from the device equals `DeviceRegistry.popDigest` | station | The device computed the digest itself; a mismatch means a wrong chain, registry or key |
| ECDSA and ML-DSA proofs of possession | registry | Binds both keys to this device id and version |
| One registration per canonical key | registry | `pkHashUsed` |

The blob builder is `tools/mldsa/prepare.mjs`, a byte-compatible port of the
verifier's `prepare.py`; the Foundry tests accept its output.

## Seeds

A device has two 32-byte secrets drawn from its hardware RNG on first boot: the
secp256k1 key and the ML-DSA-44 KeyGen seed `xi`. The expanded ML-DSA secret key
is never stored; the device re-derives it from `xi` at every boot.

The station needs `xi` once, to re-run KeyGen. It never travels in plaintext:

1. The station makes a fresh secp256k1 key pair for this device only and sends
   the public half (`WRAP <S>`).
2. The device makes its own ephemeral key, derives a one-time key by ECDH,
   encrypts `xi` and authenticates the ciphertext, binding both public keys and
   its own address (SPEC.md 4.1).
3. The station decrypts in memory, checks the tag, the commitment and the
   KeyGen binding, then overwrites `xi` and its ephemeral secret.
4. After `registerDevice` succeeds the station sends `LOCK`. From then on the
   device answers `WRAP` with `ERR locked`, so the seed cannot be exported again
   by anyone who later gets hold of the USB port.

The station keeps no copy of `xi`. What it does keep, in
`provision/out/<deviceId>-<chainId>.json`, is public: the device id, address,
pkHash, seed commitment, blob address and code hash, the pop digest, the
registration transaction and the lock state. That record states that this key
took the seed-binding path; a key registered without it would only have passed
the floor.

## Ceremony, edge device (normal path)

Roles: an operator at the station, a second person witnessing and signing the
log. Do it at a bench with the board on a known USB cable, not over a network.

1. Flash the release firmware built from a tagged commit; record the image
   SHA-256 from `pio run` output. Production images have flash encryption and
   secure boot enabled (see firmware/README.md); the first boot generates the
   seeds inside the encrypted NVS partition.
2. `KUTLE_DEVICE=/dev/cu.usbmodemXXXX node provision/src/cli.ts inspect` and
   check that `locked` is `0` and the firmware string matches the release.
3. Write the device label (pack serial) on the log sheet and run

   ```
   RPC_URL=... DEVICE_REGISTRY=0x... REGISTRAR_KEY=0x... \
   KUTLE_SIGNER=edge KUTLE_DEVICE=/dev/cu.usbmodemXXXX \
   node provision/src/cli.ts register --operator 0x<economic operator> --label <pack serial>
   ```

   The command stops at the first failed check and registers nothing.
4. Check the printed record: `seedBinding: verified`, `locked: true`, and a
   `largeLiftCount` near 1000 (a genuine key has about 97.7 % large
   coefficients).
5. Both people sign the log with the device id, address, pkHash, commitment and
   registration transaction. Archive the JSON record with it.

The registrar key should live on a hardware wallet or be a short-lived key that
the admin grants `REGISTRAR_ROLE` for the session and revokes afterwards.

## Ceremony, gateway fallback

When no board is available the gateway can sign from an encrypted keystore. The
keys then sit on a general-purpose computer, which is weaker custody than the
device; records should say which path a device took (`signerMode` in the
provisioning record).

```
KUTLE_KEYSTORE_PASSPHRASE=... node provision/src/cli.ts keygen --out device.keystore.json
KUTLE_SIGNER=gateway KUTLE_KEYSTORE=device.keystore.json KUTLE_KEYSTORE_PASSPHRASE=... \
RPC_URL=... DEVICE_REGISTRY=0x... REGISTRAR_KEY=0x... \
node provision/src/cli.ts register --operator 0x... --label <pack serial>
```

The keystore is AES-256-GCM under a scrypt key (N = 2^17, r = 8, p = 1), with
the address as associated data. The seed binding is still checked: the station
re-derives the key from the keystore's `xi`.

## Rotation and loss

A lost or compromised device is revoked with `DeviceRegistry.revokeKey` by an
`AUTHORITY_ROLE` holder. A replacement board is provisioned with `rotateKey`
(not yet wrapped by this CLI); the same checks apply to the new key.
