import { createPublicClient, createWalletClient, defineChain, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, RPC_URL, demoKey, type Role } from "../config/index.ts";

export const chain: Chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 31337 ? "Local demo chain" : CHAIN_ID === 84532 ? "Base Sepolia" : `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 1000 });

export function roleWallet(role: Role) {
  const key = demoKey(role);
  if (!key) throw new Error(`No demo key configured for ${role} (VITE_DEMO_KEY_*)`);
  const account = privateKeyToAccount(key);
  return createWalletClient({ account, chain, transport: http(RPC_URL), pollingInterval: 500 });
}

export function roleAddress(role: Role): `0x${string}` | undefined {
  const key = demoKey(role);
  return key ? privateKeyToAccount(key).address : undefined;
}

export const explorerTx = (hash: string): string | undefined =>
  CHAIN_ID === 84532 ? `https://sepolia.basescan.org/tx/${hash}` : undefined;
export const explorerAddress = (a: string): string | undefined =>
  CHAIN_ID === 84532 ? `https://sepolia.basescan.org/address/${a}` : undefined;
