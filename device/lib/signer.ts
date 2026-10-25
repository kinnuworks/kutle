// The two signing modes behind one interface.
//
//   edge     the ESP32-S3 holds the keys; it receives the raw readings,
//            recomputes every leaf, the root and the digest, and signs.
//   gateway  FALLBACK for when no board is attached: the gateway signs from an
//            encrypted keystore file. The keys then live on a general-purpose
//            computer, which is a weaker custody story than the edge device.
//
// Whatever the mode, the gateway recomputes the root and digest and checks both
// signatures before it spends gas, so a misbehaving device or a corrupted
// keystore is caught off chain.

import { keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { batchDigest, popDigest } from "./digest.ts";
import { EdgeClient, type SignedBatch, type Signature } from "./edge.ts";
import { ecdsaAddress, ecdsaSignDigest, mldsaKeygen, mldsaSign, mldsaVerify } from "./keys.ts";
import { openKeystore, passphraseFromEnv, readKeystore } from "./keystore.ts";
import { merkleRoot } from "./merkle.ts";
import { readingLeaf, type Reading } from "./reading.ts";

export interface BatchContext {
  chainId: bigint;
  readingLog: Address;
  deviceId: Hex;
  passportId: bigint;
  seq: bigint;
}

export interface PopContext {
  chainId: bigint;
  registry: Address;
  deviceId: Hex;
  version: number;
}

export interface Signer {
  readonly mode: "edge" | "gateway";
  address: Address;
  publicKey: Uint8Array;
  signBatch(ctx: BatchContext, readings: readonly Reading[]): Promise<SignedBatch>;
  signPop(ctx: PopContext): Promise<Signature>;
  close(): void;
}

export function expectedBatch(ctx: BatchContext, readings: readonly Reading[]) {
  if (readings.length === 0) throw new Error("empty batch");
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].timestamp < readings[i - 1].timestamp) throw new Error("readings must be in time order");
  }
  const root = merkleRoot(readings.map(readingLeaf));
  const fromTs = BigInt(readings[0].timestamp);
  const toTs = BigInt(readings[readings.length - 1].timestamp);
  const count = readings.length;
  const digest = batchDigest(ctx.chainId, ctx.readingLog, {
    deviceId: ctx.deviceId, passportId: ctx.passportId, seq: ctx.seq, root, fromTs, toTs, count,
  });
  return { root, fromTs, toTs, count, digest };
}

/** Throws unless both signatures over `digest` belong to this signer. */
export async function checkSignature(s: Signer, sig: Signature): Promise<void> {
  const rec = await recoverMessageAddress({ message: { raw: sig.digest }, signature: sig.ecdsaSig });
  if (rec !== s.address) throw new Error(`ECDSA signature recovers to ${rec}, expected ${s.address}`);
  if (!mldsaVerify(sig.digest, sig.mldsaSig, s.publicKey)) throw new Error("ML-DSA-44 signature does not verify");
}

export class GatewaySigner implements Signer {
  readonly mode = "gateway" as const;
  address: Address;
  publicKey: Uint8Array;
  private ecdsaKey: Hex;
  private secretKey: Uint8Array;

  constructor(ecdsaKey: Hex, xi: Uint8Array) {
    this.ecdsaKey = ecdsaKey;
    this.address = ecdsaAddress(ecdsaKey);
    const kp = mldsaKeygen(xi);
    this.publicKey = kp.publicKey;
    this.secretKey = kp.secretKey;
  }

  static fromKeystore(path: string, passphrase = passphraseFromEnv()): GatewaySigner {
    const s = openKeystore(readKeystore(path), passphrase);
    return new GatewaySigner(s.ecdsaKey, s.xi);
  }

  private async sign(digest: Hex): Promise<Signature> {
    return { digest, ecdsaSig: await ecdsaSignDigest(this.ecdsaKey, digest), mldsaSig: mldsaSign(digest, this.secretKey) };
  }

  async signBatch(ctx: BatchContext, readings: readonly Reading[]): Promise<SignedBatch> {
    const e = expectedBatch(ctx, readings);
    return { ...e, ...(await this.sign(e.digest)) };
  }

  async signPop(ctx: PopContext): Promise<Signature> {
    const pkHash = keccak256(this.publicKey);
    return this.sign(popDigest(ctx.chainId, ctx.registry, ctx.deviceId, ctx.version, this.address, pkHash));
  }

  close(): void {
    this.secretKey.fill(0);
  }
}

export class EdgeSigner implements Signer {
  readonly mode = "edge" as const;
  address!: Address;
  publicKey!: Uint8Array;
  readonly client: EdgeClient;

  private constructor(client: EdgeClient) {
    this.client = client;
  }

  static async open(spec: string): Promise<EdgeSigner> {
    const s = new EdgeSigner(EdgeClient.open(spec));
    await s.client.ping();
    const id = await s.client.id();
    s.address = id.address;
    s.publicKey = await s.client.publicKey();
    if (keccak256(s.publicKey) !== id.pkHash) throw new Error("device pk does not match its reported pkHash");
    return s;
  }

  async signBatch(ctx: BatchContext, readings: readonly Reading[]): Promise<SignedBatch> {
    const want = expectedBatch(ctx, readings);
    const got = await this.client.signBatch(ctx.chainId, ctx.readingLog, ctx.deviceId, ctx.passportId, ctx.seq, readings);
    for (const k of ["root", "digest"] as const) {
      if (got[k].toLowerCase() !== want[k].toLowerCase()) throw new Error(`device ${k} ${got[k]} differs from gateway ${want[k]}`);
    }
    if (got.fromTs !== want.fromTs || got.toTs !== want.toTs || got.count !== want.count) {
      throw new Error("device batch window differs from the gateway's");
    }
    await checkSignature(this, got);
    return got;
  }

  async signPop(ctx: PopContext): Promise<Signature> {
    const want = popDigest(ctx.chainId, ctx.registry, ctx.deviceId, ctx.version, this.address, keccak256(this.publicKey));
    const got = await this.client.pop(ctx.chainId, ctx.registry, ctx.deviceId, ctx.version);
    if (got.digest.toLowerCase() !== want.toLowerCase()) throw new Error("device pop digest differs from the gateway's");
    await checkSignature(this, got);
    return got;
  }

  close(): void {
    this.client.close();
  }
}

export async function openSigner(opts: { mode: string; device?: string; keystore?: string }): Promise<Signer> {
  if (opts.mode === "edge") {
    if (!opts.device) throw new Error("edge mode needs a device: KUTLE_DEVICE=/dev/cu.usbmodemXXXX or sim:<path>");
    return EdgeSigner.open(opts.device);
  }
  if (opts.mode === "gateway") {
    if (!opts.keystore) throw new Error("gateway mode needs KUTLE_KEYSTORE=<file>");
    console.error("signing mode: gateway (fallback, keys held on this computer; attach the board for edge mode)");
    return GatewaySigner.fromKeystore(opts.keystore);
  }
  throw new Error(`unknown signing mode ${opts.mode}; use edge or gateway`);
}
