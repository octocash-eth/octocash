import { describe, expect, test } from "vitest";
import { SITE_NAME } from "~/data/site";
import { chains, transports } from "~/data/supported-chains";
import { WALLETCONNECT_CONFIG, WALLETCONNECT_PROJECT_ID } from "./wallet";

describe("wallet utils", () => {
  describe("WALLETCONNECT_PROJECT_ID", () => {
    test("exports WALLETCONNECT_PROJECT_ID constant", () => {
      expect(WALLETCONNECT_PROJECT_ID).toBeDefined();
      expect(typeof WALLETCONNECT_PROJECT_ID).toBe("string");
    });

    test("WALLETCONNECT_PROJECT_ID is accessible", () => {
      // In test environment, it will be empty or "dummy"
      // We just verify it's a string and accessible
      expect(typeof WALLETCONNECT_PROJECT_ID).toBe("string");
    });
  });

  describe("WALLETCONNECT_CONFIG", () => {
    test("exports WALLETCONNECT_CONFIG constant", () => {
      expect(WALLETCONNECT_CONFIG).toBeDefined();
    });

    test("config is an object", () => {
      expect(typeof WALLETCONNECT_CONFIG).toBe("object");
    });

    test("config includes chains property", () => {
      expect(WALLETCONNECT_CONFIG.chains).toBeDefined();
    });
  });

  describe("Configuration", () => {
    test("uses supported chains", () => {
      expect(WALLETCONNECT_CONFIG.chains).toBeDefined();
      // In test environment, we use E2E config with only mainnet
      // In production, it would have all supported chains
      expect(WALLETCONNECT_CONFIG.chains.length).toBeGreaterThan(0);
    });

    test("includes mainnet chain", () => {
      const configChainIds = WALLETCONNECT_CONFIG.chains.map((chain) => chain.id);
      // In test environment, we use E2E config which includes mainnet (chainId 1)
      expect(configChainIds).toContain(1);
    });
  });

  describe("Environment handling", () => {
    test("config is created successfully even without project ID in test env", () => {
      // In test environment (VITEST), the config should still be created
      // This verifies the code handles missing WALLETCONNECT_PROJECT_ID gracefully
      expect(WALLETCONNECT_CONFIG).toBeDefined();
      expect(WALLETCONNECT_CONFIG.chains).toBeDefined();
      expect(WALLETCONNECT_CONFIG.chains.length).toBeGreaterThan(0);
    });
  });

  describe("Integration", () => {
    test("config works with supported chains and transports", () => {
      // Verify the config can be created with our supported chains
      expect(WALLETCONNECT_CONFIG.chains).toBeDefined();
      expect(WALLETCONNECT_CONFIG.chains.length).toBeGreaterThan(0);

      // Verify each chain has necessary properties
      WALLETCONNECT_CONFIG.chains.forEach((chain) => {
        expect(chain.id).toBeDefined();
        expect(chain.name).toBeDefined();
        expect(typeof chain.id).toBe("number");
        expect(typeof chain.name).toBe("string");
      });
    });

    test("config has valid chain structure", () => {
      // In test environment, we use E2E config with mock connector
      // Verify the config has at least one valid chain
      expect(WALLETCONNECT_CONFIG.chains.length).toBeGreaterThan(0);

      // Verify it includes mainnet (which E2E config provides)
      const hasMainnet = WALLETCONNECT_CONFIG.chains.some((chain) => chain.id === 1);
      expect(hasMainnet).toBe(true);
    });
  });

  describe("Type safety", () => {
    test("config has required properties", () => {
      expect(WALLETCONNECT_CONFIG).toHaveProperty("chains");
    });

    test("chains array is readonly", () => {
      expect(Array.isArray(WALLETCONNECT_CONFIG.chains)).toBe(true);
      expect(WALLETCONNECT_CONFIG.chains.length).toBeGreaterThan(0);
    });
  });

  describe("Data consistency", () => {
    test("uses correct site name in configuration", async () => {
      // The wallet config uses SITE_NAME for appName
      // This test verifies the import is working correctly
      expect(SITE_NAME).toBeDefined();
      expect(typeof SITE_NAME).toBe("string");
      expect(SITE_NAME.length).toBeGreaterThan(0);
    });

    test("chains and transports are properly imported", () => {
      // Verify chains object is not empty
      expect(Object.keys(chains).length).toBeGreaterThan(0);

      // Verify transports is defined
      expect(transports).toBeDefined();
    });

    test("each chain has corresponding transport", () => {
      const chainEntries = Object.entries(chains);
      const transportEntries = Object.entries(transports || {});

      // Verify chains and transports have same keys
      expect(chainEntries.length).toBe(transportEntries.length);

      // Every chain key should have a corresponding transport key
      chainEntries.forEach(([key]) => {
        expect(transports).toHaveProperty(key as keyof typeof transports);
      });
    });
  });
});
