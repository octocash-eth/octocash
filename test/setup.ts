import "@testing-library/jest-dom/vitest";
import { afterAll, beforeAll, vi } from "vitest";

// Mock ResizeObserver for cmdk/Combobox tests
global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

// Mock scrollIntoView for cmdk/Combobox tests
Element.prototype.scrollIntoView = vi.fn();

// Mock console.log, console.warn and console.error for test output cleanliness
beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

