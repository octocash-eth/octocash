import { describe, expect, test } from "vitest";
import {
  accountFor,
  controlledOn,
  deployedOn,
  executorFor,
  isSafeAccount,
  type SafeAccount,
  toAccountsMap,
  toAccountsRecord,
} from "./accounts";

const OWNER = "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAA" as const;
const SAFE = "0xBBbBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbBB" as const;
const OTHER = "0xCCcCCcccccCCCCcCCcCCCcCcCcCCCcCcccCcCCCc" as const;

const safeAccount: SafeAccount = {
  kind: "safe",
  address: SAFE,
  ownerAddress: OWNER,
  deployments: {
    1: { chainId: 1, owners: [OWNER], threshold: 1, nonce: 0, version: "1.4.1", controlled: true },
    100: { chainId: 100, owners: [OTHER], threshold: 2, nonce: 5, version: "1.3.0", controlled: false },
  },
  fetchedAt: 0,
};

const accounts = toAccountsMap({ [SAFE.toLowerCase()]: safeAccount });

describe("accountFor", () => {
  test("unknown addresses default to EOA", () => {
    expect(accountFor(accounts, OTHER)).toEqual({ kind: "eoa", address: OTHER });
    expect(accountFor(undefined, OTHER).kind).toBe("eoa");
  });

  test("lookup is case-insensitive", () => {
    expect(accountFor(accounts, SAFE.toLowerCase() as typeof SAFE).kind).toBe("safe");
    expect(isSafeAccount(accounts, SAFE)).toBe(true);
  });
});

describe("deployment checks", () => {
  test("deployedOn: Safes only where verified, EOAs everywhere", () => {
    expect(deployedOn(safeAccount, 1)).toBe(true);
    expect(deployedOn(safeAccount, 100)).toBe(true);
    expect(deployedOn(safeAccount, 8453)).toBe(false);
    expect(deployedOn({ kind: "eoa", address: OTHER }, 8453)).toBe(true);
  });

  test("controlledOn requires the connected owner in that chain's owner set", () => {
    expect(controlledOn(safeAccount, 1)).toBe(true);
    expect(controlledOn(safeAccount, 100)).toBe(false); // replayed deployment, different owners
    expect(controlledOn(safeAccount, 8453)).toBe(false);
  });
});

describe("executorFor", () => {
  test("Safe transactions execute (and pay gas) via the owner EOA", () => {
    expect(executorFor(accounts, SAFE)).toBe(OWNER);
    expect(executorFor(accounts, OTHER)).toBe(OTHER);
    expect(executorFor(undefined, SAFE)).toBe(SAFE);
  });
});

describe("record round-trip", () => {
  test("toAccountsMap/toAccountsRecord preserve entries and normalize keys", () => {
    const record = toAccountsRecord(accounts);
    expect(record[SAFE.toLowerCase()]).toEqual(safeAccount);
    expect(toAccountsMap(record).get(SAFE.toLowerCase())).toEqual(safeAccount);
    expect(toAccountsMap(undefined).size).toBe(0);
  });
});
