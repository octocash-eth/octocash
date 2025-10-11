import "@testing-library/jest-dom/vitest";
import { afterAll, beforeAll, vi } from "vitest";


// Mock console.log, console.warn and console.error for test output cleanliness
beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

