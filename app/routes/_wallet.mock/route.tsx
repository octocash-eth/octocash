import { useId, useState } from "react";
import type { Address } from "viem";
import { SiteHeader } from "~/components/site";
import { TransactionPlanViewer } from "~/components/transaction-plan";
import type { ConsolidationState, TransactionStep } from "~/lib/types";
import { generateMeta } from "~/utils/meta";

export function meta() {
  return generateMeta({
    noIndex: true,
  });
}

// Mock data based on test cases
const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;
const USDC_OPTIMISM = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;
const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
const WETH_POLYGON = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619" as Address;
const USDT_OPTIMISM = "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58" as Address;
const DAI_POLYGON = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" as Address;
const WALLET = "0x1234567890123456789012345678901234567890" as Address;

// Scenario 1: Happy Path - Multi-Chain Consolidation
const happyPathState: ConsolidationState = {
  id: "happy-path",
  plan: [
    {
      id: "step-1",
      type: "swap",
      status: "success",
      chainId: 137, // Polygon
      inputTokens: [
        {
          token: WETH_POLYGON,
          amount: 200000000000000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "WETH",
          decimals: 18,
        },
      ],
      outputToken: {
        token: USDC_POLYGON,
        amount: 800000000n, // 800 USDC
        chainId: 137,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-2",
      type: "bridge",
      status: "success",
      chainId: 10, // Optimism
      inputTokens: [
        {
          token: USDC_OPTIMISM,
          amount: 1000000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 1000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-3",
      type: "bridge",
      status: "success",
      chainId: 137, // Polygon
      inputTokens: [
        {
          token: USDC_POLYGON,
          amount: 800000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 800000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-4",
      type: "attestation",
      status: "success",
      chainId: 1, // Ethereum
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
        {
          token: USDC_ETHEREUM,
          amount: 800000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 0n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-5",
      type: "claim",
      status: "success",
      chainId: 1, // Ethereum
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
        {
          token: USDC_ETHEREUM,
          amount: 800000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 801000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-6",
      type: "swap",
      status: "success",
      chainId: 1, // Ethereum
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 801000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: WBTC_ADDRESS,
        amount: 8000000n, // 0.08 WBTC
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
    },
  ] as TransactionStep[],
  currentStepIndex: 6,
  status: "completed",
  results: {
    "step-1": {
      stepId: "step-1",
      status: "success",
      chainId: 137,
      transactionHash: "0xabc123",
      actualOutput: {
        token: USDC_POLYGON,
        amount: 800000000n,
        chainId: 137,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    "step-2": {
      stepId: "step-2",
      status: "success",
      chainId: 10,
      transactionHash: "0xdef456",
    },
    "step-3": {
      stepId: "step-3",
      status: "success",
      chainId: 137,
      transactionHash: "0xghi789",
    },
    "step-4": {
      stepId: "step-4",
      status: "success",
      chainId: 1,
    },
    "step-5": {
      stepId: "step-5",
      status: "success",
      chainId: 1,
      transactionHash: "0xjkl012",
      actualOutput: {
        token: USDC_ETHEREUM,
        amount: 801000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    "step-6": {
      stepId: "step-6",
      status: "success",
      chainId: 1,
      transactionHash: "0xmno345",
      actualOutput: {
        token: WBTC_ADDRESS,
        amount: 8000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
    },
  },
  sourceTokens: [],
  destinationToken: {
    token: WBTC_ADDRESS,
    chainId: 1,
    walletAddress: WALLET,
    symbol: "WBTC",
    decimals: 8,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  hasSubsequentExecution: false,
};

// Scenario 2: Partial Dependency Adaptation - One swap fails
const partialAdaptationState: ConsolidationState = {
  id: "partial-adaptation",
  plan: [
    {
      id: "step-1",
      type: "swap",
      status: "success",
      chainId: 10, // Optimism
      inputTokens: [
        {
          token: USDT_OPTIMISM,
          amount: 1000000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDT",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_OPTIMISM,
        amount: 500000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-2",
      type: "swap",
      status: "failed",
      chainId: 137, // Polygon
      inputTokens: [
        {
          token: DAI_POLYGON,
          amount: 1000000000000000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      outputToken: {
        token: USDC_POLYGON,
        amount: 500000n,
        chainId: 137,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
      error: {
        code: "SLIPPAGE_EXCEEDED",
        message: "Price changed too much during execution",
        recoverable: true,
        timestamp: Date.now(),
      },
    },
    {
      id: "step-3",
      type: "bridge",
      status: "success",
      chainId: 10,
      inputTokens: [
        {
          token: USDC_OPTIMISM,
          amount: 500000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 500000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-4",
      type: "bridge",
      status: "skipped",
      chainId: 137,
      inputTokens: [
        {
          token: USDC_POLYGON,
          amount: 500000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 500000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-5",
      type: "attestation",
      status: "success",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 500000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 0n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-6",
      type: "claim",
      status: "success",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 500000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 500000n, // Only from successful bridge
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-7",
      type: "swap",
      status: "success",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 500000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: WBTC_ADDRESS,
        amount: 4000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
    },
  ] as TransactionStep[],
  currentStepIndex: 7,
  status: "partial",
  results: {
    "step-1": {
      stepId: "step-1",
      status: "success",
      chainId: 10,
      transactionHash: "0x111",
    },
    "step-2": {
      stepId: "step-2",
      status: "failed",
      chainId: 137,
      error: {
        code: "SLIPPAGE_EXCEEDED",
        title: "Price changed too much",
        message: "Retry for new quote.",
        recoverable: true,
        timestamp: Date.now(),
      },
    },
    "step-3": {
      stepId: "step-3",
      status: "success",
      chainId: 10,
      transactionHash: "0x222",
    },
    "step-4": {
      stepId: "step-4",
      status: "skipped",
      chainId: 137,
      skipReason: "Depends on failed step: step-2",
    },
    "step-5": {
      stepId: "step-5",
      status: "success",
      chainId: 1,
    },
    "step-6": {
      stepId: "step-6",
      status: "success",
      chainId: 1,
      transactionHash: "0x333",
      actualOutput: {
        token: USDC_ETHEREUM,
        amount: 500000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    "step-7": {
      stepId: "step-7",
      status: "success",
      chainId: 1,
      transactionHash: "0x444",
    },
  },
  sourceTokens: [],
  destinationToken: {
    token: WBTC_ADDRESS,
    chainId: 1,
    walletAddress: WALLET,
    symbol: "WBTC",
    decimals: 18,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  hasSubsequentExecution: true,
};

// Scenario 3: Paused State - Mid-execution failure
const pausedState: ConsolidationState = {
  id: "paused-recovery",
  plan: [
    {
      id: "step-1",
      type: "bridge",
      status: "success",
      chainId: 10,
      inputTokens: [
        {
          token: USDC_OPTIMISM,
          amount: 1000000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 1000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-2",
      type: "attestation",
      status: "failed",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 0n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
      error: {
        code: "ATTESTATION_TIMEOUT",
        message: "Attestation not available within timeout period",
        recoverable: true,
        timestamp: Date.now(),
      },
    },
    {
      id: "step-3",
      type: "claim",
      status: "pending",
      chainId: 1,
      inputTokens: [],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 1000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-4",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: WBTC_ADDRESS,
        amount: 8000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
    },
  ] as TransactionStep[],
  currentStepIndex: 1,
  status: "paused",
  results: {
    "step-1": {
      stepId: "step-1",
      status: "success",
      chainId: 10,
      transactionHash: "0xaaa",
    },
    "step-2": {
      stepId: "step-2",
      status: "failed",
      chainId: 1,
      error: {
        code: "ATTESTATION_TIMEOUT",
        title: "Bridge attestation not received within 1 minute",
        message: "The money may be stuck in CCTPv2, use the history page to resume the transaction.",
        recoverable: true,
        timestamp: Date.now(),
      },
    },
  },
  sourceTokens: [],
  destinationToken: {
    token: WBTC_ADDRESS,
    chainId: 1,
    walletAddress: WALLET,
    symbol: "WBTC",
    decimals: 18,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  hasSubsequentExecution: false,
};

// Scenario 4: Simple Same-Chain Swap
const simpleSwapState: ConsolidationState = {
  id: "simple-swap",
  plan: [
    {
      id: "step-1",
      type: "swap",
      status: "success",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: WBTC_ADDRESS,
        amount: 8000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
    },
  ] as TransactionStep[],
  currentStepIndex: 1,
  status: "completed",
  results: {
    "step-1": {
      stepId: "step-1",
      status: "success",
      chainId: 1,
      transactionHash: "0xsimple123",
      actualOutput: {
        token: WBTC_ADDRESS,
        amount: 8000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
    },
  },
  sourceTokens: [],
  destinationToken: {
    token: WBTC_ADDRESS,
    chainId: 1,
    walletAddress: WALLET,
    symbol: "WBTC",
    decimals: 18,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  hasSubsequentExecution: false,
};

// Scenario 5: Executing State
const executingState: ConsolidationState = {
  id: "executing",
  plan: [
    {
      id: "step-1",
      type: "swap",
      status: "success",
      chainId: 137,
      inputTokens: [
        {
          token: WETH_POLYGON,
          amount: 100000000000000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "WETH",
          decimals: 18,
        },
      ],
      outputToken: {
        token: USDC_POLYGON,
        amount: 400000000n,
        chainId: 137,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-2",
      type: "bridge",
      status: "executing",
      chainId: 137,
      inputTokens: [
        {
          token: USDC_POLYGON,
          amount: 400000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 400000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-3",
      type: "attestation",
      status: "pending",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 400000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 0n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
    {
      id: "step-4",
      type: "claim",
      status: "pending",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ETHEREUM,
          amount: 400000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ETHEREUM,
        amount: 400000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    },
  ] as TransactionStep[],
  currentStepIndex: 1,
  status: "executing",
  results: {
    "step-1": {
      stepId: "step-1",
      status: "success",
      chainId: 137,
      transactionHash: "0xexec1",
    },
  },
  sourceTokens: [],
  destinationToken: {
    token: USDC_ETHEREUM,
    chainId: 1,
    walletAddress: WALLET,
    symbol: "USDC",
    decimals: 6,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  hasSubsequentExecution: false,
};

const mockScenarios = [
  {
    id: "happy-path",
    title: "Happy Path - Multi-Chain Consolidation",
    description: "All steps succeed. 0.2 ETH (Polygon) + 1 USDC (Optimism) → WBTC (Ethereum)",
    state: happyPathState,
  },
  {
    id: "partial-adaptation",
    title: "Partial Dependency Adaptation",
    description: "One swap fails, but attestation/claim adapt to continue with available tokens",
    state: partialAdaptationState,
  },
  {
    id: "paused-recovery",
    title: "Paused State - Attestation Timeout",
    description: "Attestation times out, execution paused. Shows retry/continue options",
    state: pausedState,
  },
  {
    id: "simple-swap",
    title: "Simple Same-Chain Swap",
    description: "Single swap on Ethereum: USDC → WBTC",
    state: simpleSwapState,
  },
  {
    id: "executing",
    title: "Executing State",
    description: "Active execution with one step in progress",
    state: executingState,
  },
];

export default function MockPage() {
  const [selectedScenario, setSelectedScenario] = useState(mockScenarios[0].id);
  const scenarioSelectorId = useId();

  const currentScenario = mockScenarios.find((s) => s.id === selectedScenario) ?? mockScenarios[0];

  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Transaction Plan Mock Views</h1>
          <p className="text-gray-600">Explore different transaction plan scenarios from test cases</p>
        </div>

        {/* Scenario Selector */}
        <div className="mb-8">
          <label htmlFor={scenarioSelectorId} className="block text-sm font-medium text-gray-700 mb-2">
            Select Scenario
          </label>
          <select
            id={scenarioSelectorId}
            value={selectedScenario}
            onChange={(e) => setSelectedScenario(e.target.value)}
            className="block w-full max-w-2xl px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {mockScenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.title}
              </option>
            ))}
          </select>
          <p className="mt-2 text-sm text-gray-600">{currentScenario.description}</p>
        </div>

        {/* Transaction Plan View */}
        <TransactionPlanViewer
          state={currentScenario.state}
          onComplete={(state) => console.log("Consolidation complete:", state)}
        />

        {/* Scenario Details */}
        <div className="mt-8 p-6 bg-white rounded-lg border border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Scenario Details</h2>
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-gray-700">Status</h3>
              <p className="text-gray-900">
                <span
                  className={`inline-block px-2 py-1 rounded text-sm font-medium ${
                    currentScenario.state.status === "completed"
                      ? "bg-green-100 text-green-800"
                      : currentScenario.state.status === "partial"
                        ? "bg-yellow-100 text-yellow-800"
                        : currentScenario.state.status === "paused"
                          ? "bg-orange-100 text-orange-800"
                          : currentScenario.state.status === "executing"
                            ? "bg-blue-100 text-blue-800"
                            : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {currentScenario.state.status}
                </span>
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-700">Steps</h3>
              <p className="text-gray-900">{currentScenario.state.plan.length} total steps</p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-700">Step Breakdown</h3>
              <div className="mt-2 space-y-1">
                {currentScenario.state.plan.map((step) => (
                  <div key={step.id} className="flex items-center gap-2 text-sm">
                    <span
                      className={`w-20 px-2 py-1 rounded text-xs font-medium ${
                        step.type === "swap"
                          ? "bg-purple-100 text-purple-800"
                          : step.type === "bridge"
                            ? "bg-blue-100 text-blue-800"
                            : step.type === "attestation"
                              ? "bg-orange-100 text-orange-800"
                              : step.type === "claim"
                                ? "bg-green-100 text-green-800"
                                : step.type === "gas-topup" || step.type === "gas-topup-wait"
                                  ? "bg-yellow-100 text-yellow-800"
                                  : "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {step.type}
                    </span>
                    <span className="text-gray-600">
                      {step.id} • Chain {step.chainId}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-700">Test Source</h3>
              <p className="text-gray-600 text-sm">
                {currentScenario.id === "happy-path"
                  ? "test/e2e/consolidation-happy-path.test.ts"
                  : currentScenario.id === "partial-adaptation"
                    ? "test/e2e/consolidation-skip.test.ts"
                    : currentScenario.id === "paused-recovery"
                      ? "test/e2e/consolidation-recovery.test.ts"
                      : currentScenario.id === "simple-swap"
                        ? "app/lib/planning.test.ts - single token same chain"
                        : "app/lib/execution.test.ts"}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
