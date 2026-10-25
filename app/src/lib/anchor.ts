// Build and sign a reading batch in the browser with a demo device key.

import { bytesToHex, type Hex } from "viem";
import { passportRegistryAbi, readingLogAbi } from "../abi/index.ts";
import { publicClient } from "./chain.ts";
import { dep } from "./data.ts";
import { deviceKey, hybridSign } from "./device.ts";
import { batchOf, generateReadings, type Reading } from "./readings.ts";

export interface SignedBatch {
  args: readonly [Hex, bigint, bigint, Hex, bigint, bigint, number, Hex, Hex];
  readings: Reading[];
  digest: Hex;
}

/**
 * Fresh readings for a device's next batch, signed with its demo key. With
 * `forgeMldsa` the ML-DSA signature is replaced by random bytes of the right
 * size, which is what an attacker holding only the ECDSA key can produce.
 */
export async function signNextBatch(label: string, deviceId: Hex, opts: { passportId?: bigint; forgeMldsa?: boolean; count?: number } = {}): Promise<SignedBatch> {
  const d = dep();
  const [seq, lastTo, blk] = await Promise.all([
    publicClient.readContract({ address: d.readingLog, abi: readingLogAbi, functionName: "nextSeq", args: [deviceId] }),
    publicClient.readContract({ address: d.readingLog, abi: readingLogAbi, functionName: "lastToTs", args: [deviceId] }),
    publicClient.getBlock(),
  ]);
  const passportId = opts.passportId ?? (await publicClient.readContract({ address: d.passportRegistry, abi: passportRegistryAbi, functionName: "passportOfDevice", args: [deviceId] }));
  const count = opts.count ?? 8;
  const step = 2;
  const now = Number(blk.timestamp);
  const from = Math.max(Number(lastTo), now - count * step - 5);
  const readings = generateReadings({ designCapacity_mAh: 60_000, soh: 0.72, cycles: 2_700, fadePerCycle: 0.0001, cyclesPerDay: 0.6 }, from, count, step, now % 100_000);
  const b = batchOf(readings);
  const digest = await publicClient.readContract({
    address: d.readingLog, abi: readingLogAbi, functionName: "batchDigest",
    args: [deviceId, passportId, seq, b.root, BigInt(b.fromTs), BigInt(b.toTs), b.count],
  });
  const k = deviceKey(label);
  const { ecdsaSig, mldsaSig } = await hybridSign(k, digest);
  const ml = opts.forgeMldsa ? bytesToHex(crypto.getRandomValues(new Uint8Array(2420))) : mldsaSig;
  return { args: [deviceId, passportId, seq, b.root, BigInt(b.fromTs), BigInt(b.toTs), b.count, ecdsaSig, ml] as const, readings, digest };
}
