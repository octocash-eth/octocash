import { describe, expect, test } from "vitest";
import { cn, formatAddress, tryCatch } from "./utils.js";

describe("utils", () => {
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

  describe("tryCatch", () => {
    test("returns value and null error when promise resolves", async () => {
      const result = await tryCatch(Promise.resolve("success"));

      expect(result).toEqual(["success", null]);
    });

    test("returns null value and error when promise rejects", async () => {
      const error = new Error("Failed");
      const result = await tryCatch(Promise.reject(error));

      expect(result).toEqual([null, error]);
    });

    test("handles resolved promises with different types", async () => {
      const numberResult = await tryCatch(Promise.resolve(42));
      expect(numberResult).toEqual([42, null]);

      const objectResult = await tryCatch(Promise.resolve({ key: "value" }));
      expect(objectResult).toEqual([{ key: "value" }, null]);

      const nullResult = await tryCatch(Promise.resolve(null));
      expect(nullResult).toEqual([null, null]);
    });

    test("converts thrown non-Error objects to Error", async () => {
      const result = await tryCatch(Promise.reject("string error"));

      expect(result[0]).toBeNull();
      expect(result[1]).toBe("string error");
    });

    test("works with async function results", async () => {
      const asyncFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "async result";
      };

      const result = await tryCatch(asyncFn());

      expect(result).toEqual(["async result", null]);
    });

    test("works with async function that throws", async () => {
      const asyncFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("Async error");
      };

      const result = await tryCatch(asyncFn());

      expect(result[0]).toBeNull();
      expect(result[1]).toBeInstanceOf(Error);
      expect(result[1]?.message).toBe("Async error");
    });
  });
});
