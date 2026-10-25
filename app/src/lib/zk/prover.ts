// UltraHonk proving for circuits/shielded_spend with noir_js and bb.js. Runs in
// the browser (the maker console) and in Node (the seeding script); the caller
// supplies the compiled circuit JSON.

import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { toHex32 } from "./notes.ts";

export interface CompiledCircuit {
  bytecode: string;
  abi: unknown;
  [k: string]: unknown;
}

export interface ProofResult {
  proof: `0x${string}`;
  publicInputs: `0x${string}`[];
  timings: { witnessMs: number; proveMs: number; verifyMs: number };
}

const toHex = (b: Uint8Array) => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

export async function proveSpend(
  circuit: CompiledCircuit,
  inputs: Record<string, unknown>,
  opts: { threads?: number; keepAlive?: boolean; onStage?: (stage: "witness" | "prove" | "verify") => void } = {},
): Promise<ProofResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noir = new Noir(circuit as any);
  opts.onStage?.("witness");
  const t0 = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { witness } = await noir.execute(inputs as any);
  const t1 = performance.now();
  opts.onStage?.("prove");
  const reuse = opts.keepAlive ?? false;
  const api = reuse ? await sharedApi(opts.threads) : await Barretenberg.new(opts.threads ? { threads: opts.threads } : {});
  try {
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: "evm" });
    const t2 = performance.now();
    opts.onStage?.("verify");
    const ok = await backend.verifyProof({ proof, publicInputs }, { verifierTarget: "evm" });
    const t3 = performance.now();
    if (!ok) throw new Error("bb.js rejected its own proof");
    return {
      proof: toHex(proof),
      publicInputs: publicInputs.map((x: string) => toHex32(BigInt(x))),
      timings: { witnessMs: Math.round(t1 - t0), proveMs: Math.round(t2 - t1), verifyMs: Math.round(t3 - t2) },
    };
  } finally {
    if (!reuse) await api.destroy();
  }
}

// One Barretenberg instance per page: its setup (wasm compile and CRS) dominates
// the first proof, so later proofs reuse it.
let shared: Promise<Barretenberg> | undefined;
function sharedApi(threads?: number): Promise<Barretenberg> {
  shared ??= Barretenberg.new(threads ? { threads } : {});
  return shared;
}

/** Start the prover's setup early (for example when the maker console opens). */
export function warmUpProver(threads?: number): void {
  void sharedApi(threads).catch(() => {
    shared = undefined;
  });
}
