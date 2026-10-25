import type { Abi, Address, Hex, TransactionReceipt } from "viem";
import type { Role } from "../config/index.ts";
import { publicClient, roleWallet } from "./chain.ts";
import { decodeRevertData, revertDataFrom, type DecodedError } from "./errors.ts";

export interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

export async function sendAndWait(role: Role, call: Call): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const w = roleWallet(role);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { request } = await publicClient.simulateContract({ account: w.account, ...(call as any) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hash = await w.writeContract(request as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return { hash, receipt };
}

export interface FailedTx {
  /** the revert reason from simulating the call (eth_call) */
  decoded: DecodedError | null;
  /** the transaction that was sent anyway and mined as reverted */
  hash?: Hex;
  status?: "success" | "reverted";
  gasUsed?: bigint;
  blockNumber?: bigint;
  /** set if the call unexpectedly succeeded in simulation */
  unexpectedSuccess?: boolean;
}

/**
 * Send a transaction that must fail. The call is simulated first to get the
 * revert data, then sent for real with a fixed gas limit (skipping estimation,
 * which would refuse it) so it is mined and visible as a reverted transaction.
 */
export async function sendExpectingRevert(role: Role, call: Call, gas = 6_000_000n): Promise<FailedTx> {
  const w = roleWallet(role);
  let decoded: DecodedError | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await publicClient.simulateContract({ account: w.account, ...(call as any) });
    return { decoded: null, unexpectedSuccess: true };
  } catch (e) {
    const data = revertDataFrom(e);
    decoded = data !== undefined ? decodeRevertData(data) : null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hash = await w.writeContract({ ...(call as any), gas, account: w.account, chain: w.chain });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { decoded, hash, status: receipt.status, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
}
