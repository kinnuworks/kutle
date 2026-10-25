// Deploys the contracts the device side talks to onto a development chain
// (anvil), from the Foundry build output in contracts/out, the same way
// contracts/test/utils/KutleTest.sol wires them. Used by the end-to-end test
// and for trying the gateway by hand.
//
//   anvil --hardfork osaka &
//   node scripts/local-chain.ts deploy            prints the addresses as JSON
//   node scripts/local-chain.ts issue --device-id <bytes32> [--label <gs1>]
//
// Environment: RPC_URL (default http://127.0.0.1:8545), DEPLOYER_KEY (default
// anvil account 0). Run `forge build` in contracts/ first if contracts/out is
// missing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decodeEventLog, keccak256, parseAbi, stringToHex, type Abi, type Address, type Hex } from "viem";
import { clients, rawDeployInitcode, type Clients } from "../lib/chain.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
export const DEPLOYMENT_FILE = resolve(here, "../gateway/data/local-deployment.json");

/** anvil's first default account; only ever used against a local dev chain. */
export const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const p = resolve(repo, `contracts/out/${name}.sol/${name}.json`);
  if (!existsSync(p)) throw new Error(`${p} not found; run forge build in contracts/`);
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export interface Deployment {
  chainId: string;
  admin: Address;
  f1600Helper: Address;
  mldsaVerifier: Address;
  deviceRegistry: Address;
  modelRegistry: Address;
  passportRegistry: Address;
  readingLog: Address;
}

async function deploy(c: Clients, name: string, args: unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(name);
  const hash = await c.wallet!.deployContract({ abi, bytecode, args });
  const r = await c.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploying ${name} failed`);
  return r.contractAddress;
}

async function send(c: Clients, address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<void> {
  const { request } = await c.publicClient.simulateContract({ account: c.wallet!.account, address, abi, functionName, args });
  const hash = await c.wallet!.writeContract(request);
  const r = await c.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}

export async function deploySystem(c: Clients): Promise<Deployment> {
  if (!c.wallet) throw new Error("deploySystem needs a wallet");
  const admin = c.wallet.account.address;

  const helperHex = readFileSync(resolve(repo, "contracts/lib/evm-ml-dsa-verifier/helpers/f1600_170.hex"), "utf8").trim();
  const helper = Buffer.from(helperHex.replace(/^0x/, ""), "hex");
  const hh = await c.wallet.sendTransaction({ data: rawDeployInitcode(helper) });
  const f1600Helper = (await c.publicClient.waitForTransactionReceipt({ hash: hh })).contractAddress!;

  const mldsaVerifier = await deploy(c, "MLDSA44Verifier", [f1600Helper]);
  const deviceRegistry = await deploy(c, "DeviceRegistry", [admin]);
  const modelRegistry = await deploy(c, "ModelRegistry", [admin]);
  const passportRegistry = await deploy(c, "PassportRegistry", [admin, deviceRegistry, modelRegistry]);
  const readingLog = await deploy(c, "ReadingLog", [deviceRegistry, passportRegistry]);

  const dr = artifact("DeviceRegistry").abi;
  const pr = artifact("PassportRegistry").abi;
  await send(c, deviceRegistry, dr, "setSuite", [1, mldsaVerifier, true]);
  await send(c, deviceRegistry, dr, "grantRole", [keccak256(stringToHex("REGISTRAR_ROLE")), admin]);
  await send(c, passportRegistry, pr, "grantRole", [keccak256(stringToHex("MANUFACTURER_ROLE")), admin]);

  return {
    chainId: c.chainId.toString(),
    admin,
    f1600Helper,
    mldsaVerifier,
    deviceRegistry,
    modelRegistry,
    passportRegistry,
    readingLog,
  };
}

const issuedAbi = parseAbi([
  "event Issued(uint256 indexed passportId, address indexed operator, bytes32 indexed deviceId, uint8 category, bytes32 dataHash, bytes32 gs1Hash, string uri)",
]);

/** Issue a demo-category passport bound to a registered device; the caller must be its operator. */
export async function issuePassport(c: Clients, d: Deployment, deviceId: Hex, gs1Label: string): Promise<bigint> {
  const pr = artifact("PassportRegistry").abi;
  const params = {
    deviceId,
    category: 9, // CAT_DEMO: a portable pack used to demonstrate the pipeline
    massGrams: 260,
    capacityWh: 52,
    composition: [3, 4, 8, 0],
    dataHash: keccak256(stringToHex(`battery-pass-json:${gs1Label}`)),
    gs1Hash: keccak256(stringToHex(`gs1:${gs1Label}`)),
    uri: "ipfs://kutle-demo-passport",
  };
  const { request } = await c.publicClient.simulateContract({
    account: c.wallet!.account,
    address: d.passportRegistry,
    abi: pr,
    functionName: "issue",
    args: [params],
  });
  const hash = await c.wallet!.writeContract(request);
  const r = await c.publicClient.waitForTransactionReceipt({ hash });
  for (const l of r.logs) {
    try {
      const ev = decodeEventLog({ abi: issuedAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Issued") return ev.args.passportId;
    } catch {
      /* other events */
    }
  }
  throw new Error("no Issued event");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "device-id": { type: "string" }, label: { type: "string", default: "demo-pack-1" } },
  });
  const c = await clients(process.env.RPC_URL ?? "http://127.0.0.1:8545", (process.env.DEPLOYER_KEY as Hex) ?? ANVIL_KEY_0);
  if (positionals[0] === "deploy") {
    const d = await deploySystem(c);
    mkdirSync(dirname(DEPLOYMENT_FILE), { recursive: true });
    writeFileSync(DEPLOYMENT_FILE, JSON.stringify(d, null, 2) + "\n");
    console.log(JSON.stringify(d, null, 2));
  } else if (positionals[0] === "issue") {
    const d: Deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
    const id = await issuePassport(c, d, values["device-id"] as Hex, values.label!);
    console.log(id.toString());
  } else {
    console.log("usage: local-chain.ts deploy | issue --device-id <bytes32> [--label <gs1>]");
  }
}
