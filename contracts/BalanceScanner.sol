// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

/// @notice Read-only token balance scanner. Never deployed: the app injects
/// its runtime bytecode at a throwaway address through an `eth_call` state
/// override (see app/lib/api/balance-scanner.ts), so one RPC call checks every
/// wallet × token pair and only the non-zero balances come back.
///
/// Rebuild the bytecode constant in balance-scanner.ts with:
///   solc-0.8.33 --optimize --optimize-runs 1 --evm-version paris \
///     --metadata-hash none --bin-runtime contracts/BalanceScanner.sol
contract BalanceScanner {
    /// Thrown instead of reporting a balance as zero once the call's gas
    /// budget can no longer cover a full `balanceOf` sub-call, so callers get
    /// a complete result or an error, never silently truncated data.
    error OutOfGas(uint256 tokenIndex);

    /// @param wallets Holders to check.
    /// @param tokens ERC-20 addresses; `address(0)` reads the native balance.
    /// @return out Flat pairs `[(tokenIndex << 128) | walletIndex, balance, ...]`
    ///         for every non-zero balance. Tokens whose `balanceOf` reverts or
    ///         returns short data are treated as zero.
    function scan(address[] calldata wallets, address[] calldata tokens) external view returns (uint256[] memory out) {
        out = new uint256[](2 * wallets.length * tokens.length);
        uint256 n;
        for (uint256 t; t < tokens.length; ++t) {
            address token = tokens[t];
            for (uint256 w; w < wallets.length; ++w) {
                address wallet = wallets[w];
                uint256 bal;
                if (token == address(0)) {
                    bal = wallet.balance;
                } else {
                    if (gasleft() < 120_000) revert OutOfGas(t);
                    assembly ("memory-safe") {
                        let p := mload(0x40)
                        mstore(p, 0x70a0823100000000000000000000000000000000000000000000000000000000)
                        mstore(add(p, 4), wallet)
                        // Bounded gas so a hostile or broken token can't eat the whole call.
                        // The call must be its own statement: Yul evaluates arguments
                        // right to left, so inlining it into `and(...)` would read the
                        // *previous* call's returndatasize.
                        let ok := staticcall(100000, token, p, 36, p, 32)
                        if and(ok, gt(returndatasize(), 31)) { bal := mload(p) }
                    }
                }
                if (bal != 0) {
                    out[n++] = (t << 128) | w;
                    out[n++] = bal;
                }
            }
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }
}
