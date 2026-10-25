// EIP-712 assay typed data for ConservationLedger.settle, signed with demo keys.

import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, demoKey, type Role } from "../config/index.ts";
import { dep } from "./data.ts";

export interface Assay {
  batchId: bigint;
  recovered: readonly [bigint, bigint, bigint, bigint];
  loss: readonly [bigint, bigint, bigint, bigint];
  residual: readonly [bigint, bigint, bigint, bigint];
  reportHash: Hex;
  lab: Address;
  nonce: number;
  deadline: bigint;
}

export const ASSAY_TYPES = {
  Assay: [
    { name: "batchId", type: "uint256" },
    { name: "recovered", type: "uint64[4]" },
    { name: "loss", type: "uint64[4]" },
    { name: "residual", type: "uint64[4]" },
    { name: "reportHash", type: "bytes32" },
    { name: "lab", type: "address" },
    { name: "nonce", type: "uint32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const assayDomain = () => ({ name: "Kutle ConservationLedger", version: "1", chainId: CHAIN_ID, verifyingContract: dep().conservationLedger });

export async function signAssay(role: Role, a: Assay): Promise<Hex> {
  const key = demoKey(role);
  if (!key) throw new Error(`No demo key for ${role}`);
  return privateKeyToAccount(key).signTypedData({ domain: assayDomain(), types: ASSAY_TYPES, primaryType: "Assay", message: a });
}

export const four = (xs: bigint[]) => [xs[0] ?? 0n, xs[1] ?? 0n, xs[2] ?? 0n, xs[3] ?? 0n] as const;
