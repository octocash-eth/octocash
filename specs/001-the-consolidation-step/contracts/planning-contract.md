# Contract: Transaction Planning Function

## Function Signature

```typescript
function planConsolidation(
  sourceTokens: TokenAmount[],
  destinationToken: { token: Address; chainId: number; walletAddress: Address }
): Promise<TransactionStep[]>
```

## Purpose
Generates a dynamic transaction plan to consolidate multiple source tokens into a single destination token, optimizing for gas efficiency and execution speed.

## Input

### sourceTokens: TokenAmount[]
- **Required**: Yes
- **Constraints**:
  - Minimum 1 token
  - Maximum 50 tokens (performance limit)
  - Each token must have `amount > 0`
  - All tokens must be from supported chains
- **Example**:
  ```typescript
  [
    { token: "0x...", amount: 1000000n, chainId: 10, walletAddress: "0x..." }, // 1 USDC on Optimism
    { token: "0x...", amount: 200000000000000000n, chainId: 137, walletAddress: "0x..." } // 0.2 ETH on Polygon
  ]
  ```

### destinationToken
- **Required**: Yes
- **Constraints**:
  - `chainId` must be supported
  - `token` address must be valid
  - `walletAddress` must be valid Ethereum address
- **Example**:
  ```typescript
  {
    token: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
    chainId: 1, // Ethereum
    walletAddress: "0x..." // User's destination wallet
  }
  ```

## Output

### Returns: Promise<TransactionStep[]>
- **Type**: Array of TransactionStep objects
- **Order**: Execution order (index 0 executes first)
- **Constraints**:
  - All steps have unique IDs
  - Dependencies reference earlier steps only
  - At least 1 step returned
  - Maximum 100 steps (reasonable limit)

## Behavior

### Planning Algorithm
1. **Group by chain**: Group source tokens by chainId
2. **For each source chain**:
   - **Group tokens by swap target**:
     - Tokens going to destination token (if on destination chain)
     - Tokens going to USDC (for bridging or if USDC is destination)
   - **Batch swap operations** (max 6 tokens per batch):
     - For tokens ≤6: Create one swap step with multiple inputs, one output
     - For tokens >6: Split into multiple batches (6, 6, 6, ..., remainder)
     - Each batch creates a swap step with array of input tokens → single output token
   - If source chain ≠ destination chain: Add bridge step (USDC → destination chain using CCTP)
3. **Add attestation wait step** (if any bridges)
4. **Add claim step** on destination chain (if any bridges)
5. **On destination chain**:
   - If destination token ≠ USDC and there's USDC to swap:
     - Add final swap step (USDC → destination token)
6. **Optimize bundling**: Identify steps that can be executed in parallel (same chain, no dependencies)
7. **Set dependencies**: Link steps that consume outputs from other steps

### Example Output Structure

#### Example 1: Basic Multi-Chain Consolidation
```typescript
[
  {
    id: "step-1",
    type: "swap",
    chainId: 137, // Polygon
    inputTokens: [{ token: ETH_ADDRESS, amount: 0.2e18, ... }],
    outputToken: { token: USDC_ADDRESS, amount: 800e6, ... }, // estimated
    partialDependency: false
  },
  {
    id: "step-2",
    type: "bridge",
    chainId: 10, // Optimism
    inputTokens: [{ token: USDC_ADDRESS, amount: 1e6, ... }],
    outputToken: { token: USDC_ADDRESS, amount: 1e6, chainId: 1, ... }, // Ethereum
    partialDependency: false
  },
  {
    id: "step-3",
    type: "bridge",
    chainId: 137, // Polygon
    inputTokens: [{ token: USDC_ADDRESS, amount: 800e6, ... }],
    outputToken: { token: USDC_ADDRESS, amount: 800e6, chainId: 1, ... }, // Ethereum
    partialDependency: false
  },
  {
    id: "step-4",
    type: "attestation",
    chainId: 1, // Ethereum (destination)
    inputTokens: [],
    outputToken: { token: USDC_ADDRESS, amount: 0n, ... },
    partialDependency: true // CAN execute with subset of dependencies
  },
  {
    id: "step-5",
    type: "claim",
    chainId: 1, // Ethereum
    inputTokens: [],
    outputToken: { token: USDC_ADDRESS, amount: 801e6, ... }, // Combined
    partialDependency: true // CAN claim subset of bridges
  },
  {
    id: "step-6",
    type: "swap",
    chainId: 1, // Ethereum
    inputTokens: [{ token: USDC_ADDRESS, amount: 801e6, ... }],
    outputToken: { token: WBTC_ADDRESS, amount: 0.008e8, ... }, // estimated
    partialDependency: false
  }
]
```

#### Example 2: Token Batching (Same Chain, Multiple Tokens)
When consolidating multiple tokens on the same chain and wallet:
```typescript
[
  {
    id: "step-1",
    type: "swap",
    chainId: 1, // Ethereum
    inputTokens: [
      { token: ETH_ADDRESS, amount: 0.1e18, ... },
      { token: USDC_ADDRESS, amount: 1000e6, ... }
    ], // Multiple input tokens batched together
    outputToken: { token: WBTC_ADDRESS, amount: 0.008e8, ... },
    partialDependency: false
  }
]
```

#### Example 3: Token Batching with >6 Tokens
When consolidating 8 tokens on the same chain (exceeds 6-token limit):
```typescript
[
  {
    id: "step-1",
    type: "swap",
    chainId: 1,
    inputTokens: [
      { token: TOKEN0_ADDRESS, amount: 100e18, ... },
      { token: TOKEN1_ADDRESS, amount: 200e18, ... },
      { token: TOKEN2_ADDRESS, amount: 300e18, ... },
      { token: TOKEN3_ADDRESS, amount: 400e18, ... },
      { token: TOKEN4_ADDRESS, amount: 500e18, ... },
      { token: TOKEN5_ADDRESS, amount: 600e18, ... }
    ], // First batch: 6 tokens
    outputToken: { token: WBTC_ADDRESS, amount: 0.005e8, ... },
    partialDependency: false
  },
  {
    id: "step-2",
    type: "swap",
    chainId: 1,
    inputTokens: [
      { token: TOKEN6_ADDRESS, amount: 700e18, ... },
      { token: TOKEN7_ADDRESS, amount: 800e18, ... }
    ], // Second batch: remaining 2 tokens
    outputToken: { token: WBTC_ADDRESS, amount: 0.003e8, ... },
    partialDependency: false
  }
]
```

#### Example 4: Provenance-Based Partial Success (User's Scenario)
If Step 1 succeeds but Step 2 fails during execution:
- Step 3 (bridge from Polygon) executes successfully
- Step 4 (bridge from Optimism) is skipped (input has provenance from failed Step 2)
- **Step 5 (attestation) CONTINUES**: 
  - Has two input tokens: one from Step 3 (success), one from Step 4 (skipped)
  - Since at least one input has successful provenance (Step 3), attestation continues
  - Only processes attestation for the successful bridge
- **Step 6 (claim) CONTINUES**:
  - Has input token from Step 3 via attestation provenance
  - Claims only USDC from successful bridge
  - Amount is ~800 USDC (not 801)
- Step 7 continues with actual amount from claim

## Error Cases

### Invalid Input
- **Throws**: `PlanningError`
- **When**:
  - `sourceTokens` is empty
  - `sourceTokens` exceeds 50 tokens
  - Any token has `amount <= 0`
  - Unsupported chain in sourceTokens or destinationToken
  - Invalid address format

### Unsupported Route
- **Throws**: `UnsupportedRouteError`
- **When**:
  - Token not supported by Odos on source chain
  - No bridge route available between chains
  - Destination token not available on destination chain

### API Failure
- **Throws**: `ExternalAPIError`
- **When**:
  - Odos API unavailable for swap quotes
  - CCTP contracts not accessible

## Dependencies

### External APIs
- **Odos Quote API**: For swap amount estimation
- **Odos Supported Chains**: For chain/token validation
- **CCTP Contracts**: For bridge fee calculation

### Helper Functions (implemented)
```typescript
// In app/lib/odos.ts
function getSwapQuote(
  input: TokenAmount | TokenAmount[], // Can accept single token or array for batching
  outputToken: Omit<TokenAmount, "amount">
): Promise<TokenAmount>

// In app/lib/cctp.ts
function getBridgeFee(amount: bigint, sourceChain: number, destChain: number): Promise<bigint>

// In app/lib/planning.ts
function batchTokens(tokens: TokenAmount[], maxBatchSize: number): TokenAmount[][] // Split tokens into batches
```

## Performance

### Time Complexity
- O(n) where n = number of source tokens
- Additional O(n) for Odos API calls (can be parallelized)

### Expected Execution Time
- 2-5 seconds for typical consolidation (3-10 tokens)
- Primarily limited by external API latency

## Testing

### Test Cases (Contract Tests)
1. **Single token, same chain**: Should return only swap or transfer step
2. **Multiple tokens, different chains**: Should include swaps, bridges, attestation, claim, final swap
3. **Token already USDC**: Should skip initial swap
4. **Token already on destination chain**: Should skip bridge
5. **Multiple tokens same chain**: Should batch tokens into single swap step with multiple inputs
6. **More than 6 tokens same chain**: Should split into multiple batches (max 6 per batch)
7. **Same chain WETH to WBTC**: Should plan direct swap without going through USDC
8. **Invalid input**: Should throw PlanningError with descriptive message
9. **Unsupported chain**: Should throw UnsupportedRouteError
10. **API failure**: Should throw ExternalAPIError and preserve user context

### Edge Cases
- All tokens already destination token: Just transfer steps
- 50 tokens (maximum): Should complete within 10 seconds, creating multiple batches
- Destination token is USDC: Optimize to bridge directly to destination wallet
- Exactly 6 tokens: Should create one batch
- 7 tokens: Should create two batches (6 + 1)
- 12 tokens: Should create two batches (6 + 6)
- 13 tokens: Should create three batches (6 + 6 + 1)
