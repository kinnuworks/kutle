import type { Address } from "viem";

export interface Deployment {
  chainId: number;
  f1600Helper: Address;
  mldsaVerifier: Address;
  poseidon2: Address;
  council: Address;
  timelock: Address;
  deviceRegistry: Address;
  modelRegistry: Address;
  passportRegistry: Address;
  readingLog: Address;
  conservationLedger: Address;
  shieldedSpendVerifier: Address;
  notePool: Address;
}

const files = import.meta.glob<{ default: Deployment }>("./deployments/*.json", { eager: true });

export const deployments: Record<number, Deployment> = Object.fromEntries(
  Object.values(files).map((m) => [Number(m.default.chainId), { ...m.default, chainId: Number(m.default.chainId) }]),
);

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 31337);
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8545";
export const deployment: Deployment | undefined = deployments[CHAIN_ID];
export const isLocalChain = CHAIN_ID === 31337;

/** Public base URL of the app, used in QR codes. */
export const APP_URL: string = import.meta.env.VITE_APP_URL ?? (typeof location !== "undefined" ? location.origin + location.pathname : "");

export type Role =
  | "deployer" | "council1" | "council2" | "council3" | "manufacturer" | "grader" | "repurposer" | "authority"
  | "registrar" | "recycler" | "lab" | "secondLife" | "unaccreditedLab" | "relayer";

const env = import.meta.env as Record<string, string | undefined>;
const envName = (role: Role) => `VITE_DEMO_KEY_${role.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()}`;

/** Testnet demo key for a role, from the environment. Undefined when not configured. */
export function demoKey(role: Role): `0x${string}` | undefined {
  const v = env[envName(role)];
  return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as `0x${string}`) : undefined;
}

export const demoSecret = (name: "MAKER" | "ATTACKER"): bigint | undefined => {
  const v = env[`VITE_DEMO_${name}_SECRET`];
  return v ? BigInt(v) : undefined;
};

/** First block to scan for events (the deployment block on a public testnet). */
export const FROM_BLOCK = BigInt(import.meta.env.VITE_FROM_BLOCK ?? 0);
