// The two digests a device signs (SPEC.md section 3), restated from
// DeviceRegistry.popDigest and ReadingLog.batchDigest.

import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";

export const POP_TAG = keccak256(stringToHex("KUTLE_DEVICE_POP_V1"));

export const BATCH_TYPEHASH = keccak256(
  stringToHex(
    "KutleReadingBatch(bytes32 deviceId,uint256 passportId,uint64 seq,bytes32 root,uint64 fromTs,uint64 toTs,uint32 count)",
  ),
);

export interface BatchHeader {
  deviceId: Hex;
  passportId: bigint;
  seq: bigint;
  root: Hex;
  fromTs: bigint;
  toTs: bigint;
  count: number;
}

export function popDigest(
  chainId: bigint,
  registry: Address,
  deviceId: Hex,
  version: number,
  ecdsaSigner: Address,
  pkHash: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" },
        { type: "uint32" }, { type: "address" }, { type: "bytes32" },
      ],
      [POP_TAG, chainId, registry, deviceId, version, ecdsaSigner, pkHash],
    ),
  );
}

export function batchDigest(chainId: bigint, readingLog: Address, b: BatchHeader): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" },
        { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint32" },
      ],
      [BATCH_TYPEHASH, chainId, readingLog, b.deviceId, b.passportId, b.seq, b.root, b.fromTs, b.toTs, b.count],
    ),
  );
}
