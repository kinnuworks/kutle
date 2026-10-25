import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NoteTree, bindingOf, buildSpend, findOwnedNotes, nextSaltIndex, noteLeaf, noteSalt, ownerCommit, toHex32 } from "./notes.ts";

const FIXTURE = resolve(__dirname, "../../../../contracts/test/fixtures/zk/spend.json");

// Same scenario as tools/zk/fixture.mjs.
const OWNER_SECRET = 0x2f1c6d1b8a40e2b7c35d0e9a71f4b6c2d8e3a5f7091b2c4d6e8f0a1b3c5d7e9fn;
const SALT_A = 0x051a700000000000000000000000000000000000000000000000000000000001n;
const SALT_B = 0x051a700000000000000000000000000000000000000000000000000000000002n;
const SALT_CHANGE = 0x051a700000000000000000000000000000000000000000000000000000000003n;

describe.skipIf(!existsSync(FIXTURE))("buildSpend reproduces the contract test fixture", () => {
  const fx = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;
  it("computes the same root, nullifiers, change leaf, binding and public inputs", () => {
    const tree = new NoteTree();
    tree.insert(noteLeaf(0, 3000n, ownerCommit(OWNER_SECRET, SALT_A)));
    tree.insert(noteLeaf(0, 2000n, ownerCommit(OWNER_SECRET, SALT_B)));
    const binding = bindingOf(fx.chainId, fx.pool);
    expect(toHex32(binding)).toBe(fx.binding);
    const s = buildSpend({
      tree, element: 0, passportId: 1n, declaredGrams: 4500n, ownerSecret: OWNER_SECRET,
      notes: [{ salt: SALT_A, grams: 3000n, leafIndex: 0 }, { salt: SALT_B, grams: 2000n, leafIndex: 1 }],
      changeGrams: 500n, changeOwnerCommit: ownerCommit(OWNER_SECRET, SALT_CHANGE), binding,
    });
    expect(toHex32(s.root)).toBe(fx.root);
    expect(s.nullifiers.map(toHex32)).toEqual(fx.nullifiers);
    expect(toHex32(s.changeLeaf)).toBe(fx.changeLeaf);
    expect(s.publicInputs).toEqual(fx.publicInputs);
  });
});

describe("spend construction guards", () => {
  const secret = 12345n;
  const tree = new NoteTree();
  const salt0 = noteSalt(secret, 0);
  tree.insert(noteLeaf(1, 400n, ownerCommit(secret, salt0)));
  const base = { tree, element: 1, passportId: 7n, ownerSecret: secret, changeOwnerCommit: 0n, binding: 1n };

  it("refuses declarations that do not add up", () => {
    expect(() => buildSpend({ ...base, declaredGrams: 500n, changeGrams: 0n, notes: [{ salt: salt0, grams: 400n, leafIndex: 0 }] })).toThrow(/notes hold/);
  });
  it("refuses a note the secret does not own", () => {
    expect(() => buildSpend({ ...base, ownerSecret: 999n, declaredGrams: 400n, changeGrams: 0n, notes: [{ salt: salt0, grams: 400n, leafIndex: 0 }] })).toThrow(/not in tree/);
  });
  it("refuses the same note twice", () => {
    expect(() => buildSpend({ ...base, declaredGrams: 800n, changeGrams: 0n, notes: [{ salt: salt0, grams: 400n, leafIndex: 0 }, { salt: salt0, grams: 400n, leafIndex: 0 }] })).toThrow(/twice/);
  });
});

describe("wallet discovery", () => {
  it("finds notes minted to a secret and skips used salt indices", () => {
    const secret = 777n;
    const other = 888n;
    const minted = [
      { leafIndex: 0n, element: 0, grams: 3000n, leaf: noteLeaf(0, 3000n, ownerCommit(secret, noteSalt(secret, 0))) },
      { leafIndex: 1n, element: 0, grams: 500n, leaf: noteLeaf(0, 500n, ownerCommit(other, noteSalt(other, 0))) },
      { leafIndex: 2n, element: 2, grams: 2500n, leaf: noteLeaf(2, 2500n, ownerCommit(secret, noteSalt(secret, 1))) },
    ];
    const owned = findOwnedNotes(secret, minted, [], 8);
    expect(owned.map((n) => n.leafIndex)).toEqual([0, 2]);
    expect(nextSaltIndex(owned)).toBe(2);
    expect(nextSaltIndex(owned, [2, 3])).toBe(4);
  });
});
