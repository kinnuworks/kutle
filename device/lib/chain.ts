// ABI fragments for the calls the device side makes, and viem clients from env.

import { createPublicClient, createWalletClient, http, keccak256, parseAbi, stringToHex, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const readingLogAbi = parseAbi([
  "function anchor(bytes32 deviceId, uint256 passportId, uint64 seq, bytes32 root, uint64 fromTs, uint64 toTs, uint32 count, bytes ecdsaSig, bytes mldsaSig) returns (bytes32 batchId)",
  "function nextSeq(bytes32 deviceId) view returns (uint64)",
  "function lastToTs(bytes32 deviceId) view returns (uint64)",
  "function batchDigest(bytes32 deviceId, uint256 passportId, uint64 seq, bytes32 root, uint64 fromTs, uint64 toTs, uint32 count) view returns (bytes32)",
  "function verifyReading(bytes32 batchId, bytes32 leaf, bytes32[] proof) view returns (bool)",
  "function batch(bytes32 batchId) view returns ((bytes32 deviceId, uint256 passportId, bytes32 root, uint64 fromTs, uint64 toTs, uint32 count, uint32 keyVersion, uint64 anchoredAt))",
  "function passports() view returns (address)",
  "function deviceRegistry() view returns (address)",
  "event BatchAnchored(bytes32 indexed batchId, bytes32 indexed deviceId, uint256 indexed passportId, uint64 seq, bytes32 root, uint64 fromTs, uint64 toTs, uint32 count, uint32 keyVersion)",
  "error WrongDevice()",
  "error BadSequence(uint64 expected, uint64 got)",
  "error BadWindow()",
  "error EmptyBatch()",
  "error UnknownBatch()",
  "error UnknownDevice()",
  "error KeyIsRevoked()",
  "error BadEcdsaPoP()",
  "error BadMldsaPoP()",
  "error SuiteDisabled(uint8 suite)",
  "error VerifierSwapped()",
  "error BadBlob()",
]);

export const deviceRegistryAbi = parseAbi([
  "function registerDevice(bytes32 deviceId, address operator, address ecdsaSigner, bytes pk, address pkBlob, bytes popEcdsa, bytes popMldsa)",
  "function popDigest(bytes32 deviceId, uint32 version, address ecdsaSigner, bytes32 pkHash) view returns (bytes32)",
  "function devices(bytes32 deviceId) view returns (address operator, uint32 keyVersion, bool exists)",
  "function key(bytes32 deviceId, uint32 version) view returns ((address ecdsaSigner, address pkBlob, bytes32 pkBlobCodehash, bytes32 pkHash, uint8 suite, uint64 validFrom, uint64 revokedAt))",
  "function pkHashUsed(bytes32 pkHash) view returns (bool)",
  "function REGISTRAR_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "error DeviceExists()",
  "error UnknownDevice()",
  "error PkReused()",
  "error BadBlob()",
  "error SuiteDisabled(uint8 suite)",
  "error VerifierSwapped()",
  "error BadEcdsaPoP()",
  "error BadMldsaPoP()",
  "error KeyIsRevoked()",
  "error ZeroAddress()",
  "error WrongKeyLength(uint256 length)",
  "error DegenerateKey(uint256 largeCoefficients)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
]);

export const passportAbi = parseAbi(["function deviceOf(uint256 passportId) view returns (bytes32)"]);

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

export async function clients(rpcUrl: string, privateKey?: Hex) {
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  const chain: Chain = {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  // Dev chains mine instantly; poll receipts quickly there.
  const pollingInterval = chainId === 31337 ? 200 : 4000;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval });
  const wallet = privateKey
    ? createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(privateKey), pollingInterval })
    : undefined;
  return { publicClient, wallet, chainId: BigInt(chainId), chain };
}

export type Clients = Awaited<ReturnType<typeof clients>>;

export const asAddress = (s: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`not an address: ${s}`);
  return s as Address;
};

export const asBytes32 = (s: string): Hex => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error(`not a bytes32: ${s}`);
  return s.toLowerCase() as Hex;
};

/** Deploy raw runtime code with the same 12-byte init stub the tests use. */
export function rawDeployInitcode(runtime: Uint8Array): Hex {
  if (runtime.length >= 0x10000) throw new Error("runtime too large for the stub");
  const len = runtime.length.toString(16).padStart(4, "0");
  return `0x61${len}80600c6000396000f3${Buffer.from(runtime).toString("hex")}` as Hex;
}

/** A device id from a human label such as a pack serial: keccak256("kutle-device:" + label). */
export const deviceIdFromLabel = (label: string): Hex => keccak256(stringToHex(`kutle-device:${label}`));
