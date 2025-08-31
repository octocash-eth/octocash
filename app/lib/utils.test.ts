import { describe, expect, test } from "vitest";
import { cn, formatAddress } from "./utils.js";

describe("formatAddress", () => {
  test("formats address correctly", () => {
    expect(formatAddress("0x1234567890123456789012345678901234567890")).toBe("0x1234..7890");
  });

  test("returns original address when address is empty", () => {
    expect(formatAddress("")).toBe("");
  });

  test("formats address correctly when address is shorter than 10 characters", () => {
    expect(formatAddress("0x12345")).toBe("0x12345");
  });

  test("formats address correctly when address is not a valid address", () => {
    expect(formatAddress("0x12345678901234567890123456789012345678901234567890")).toBe("0x1234..7890");
  });
});

describe("cn", () => {
  test("cn merges conflicting tailwind classes", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  test("cn supports conditional class objects", () => {
    expect(cn("px-2", { "mt-2": true, "mt-4": false })).toBe("px-2 mt-2");
  });
});
