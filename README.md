# Octocash

Octocash is a simple app that gathers your crypto scattered across multiple chains and wallets into one place. It automatically swaps and bridges assets behind the scenes so all value ends up as your chosen token in your chosen destination wallet, reducing manual steps and fees while keeping the process fast and reliable.

## Consolidation Overview

- **Input**: A set of token balances, each with balance, token address, `chainId` and source wallet; plus a desired token and a destination wallet.
- **Goal**: Convert and collect all value into the desired token in the destination wallet on the desired token's chain.

### Process

1. **Per-chain, per-wallet (off destination chain): swap to USDC**
   - For every chain and wallet that is not the destination chain:
     - Swap all tokens to USDC using Delora, except USDC itself.
   - NOTE: Balances already on the destination chain are skipped here; they’ll be handled in step 3.

2. **Bridge to the destination chain**
   - For every chain and wallet (except the destination chain), bridge the USDC via CCTP to a consolidation wallet on the destination chain.
   - If the desired token is USDC, bridge directly to the destination wallet.

3. **On the destination chain: finalize and collect**
   - For each wallet on the destination chain, swap remaining tokens (including the bridged USDC) to the desired token using Delora and send to the destination wallet.
   - If all or part of the balance was already in the desired token on the destination chain but sits in a different wallet, perform a simple transfer (no swap).

### In short
- **Step 1**: Convert off-destination-chain assets to USDC.
- **Step 2**: Move USDC to the destination chain via CCTP.
- **Step 3**: Convert to the desired token and consolidate into the destination wallet.

## Development

```bash
bun run dev
```

## Production

```bash
bun run build
```

## Linting

```bash
bun run lint
```
