import { useQuery } from "@tanstack/react-query";
import type { RowSelectionState } from "@tanstack/react-table";
import * as React from "react";
import { ConsolidateTokensModal } from "~/components/consolidate-tokens-modal";
import { fetchExtraTokenBalances, fetchZerionTokenBalances } from "~/lib/api";
import { getTokenAmountInUsd, isSameToken } from "~/lib/tokens";
import { columns } from "./columns";
import { DataTable } from "./data-table";

interface WalletTableProps {
  connectedAddresses?: readonly string[];
}

// Empty state component
const EmptyState = ({ hasAddresses }: { hasAddresses: boolean }) => (
  <div className="flex flex-col items-center justify-center h-64 text-center">
    <p className="mb-2 text-muted-foreground">No tokens found</p>
    <p className="text-sm text-muted-foreground">
      {hasAddresses ? "Connect a wallet with tokens or try a different address" : "Connect a wallet to see your tokens"}
    </p>
  </div>
);

export function WalletTable({ connectedAddresses = [] }: WalletTableProps) {
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  // Stable addresses key for query
  const addressesKey = React.useMemo(() => Array.from(connectedAddresses).sort().join(","), [connectedAddresses]);
  const addresses = React.useMemo(() => Array.from(connectedAddresses), [connectedAddresses]);

  // Query for Zerion tokens (fast, indexed)
  const zerionQuery = useQuery({
    queryKey: ["zerion-tokens", addressesKey],
    queryFn: () => fetchZerionTokenBalances(addresses),
    enabled: addresses.length > 0,
    staleTime: 30_000, // 30 seconds
  });

  // Query for extra tokens (slower, RPC calls) - runs after Zerion data is loaded
  const extraQuery = useQuery({
    queryKey: ["extra-tokens", addressesKey],
    queryFn: async () => {
      return fetchExtraTokenBalances(addresses);
    },
    // Only fetch extra tokens after Zerion query succeeds to reduce concurrent RPC load
    enabled: addresses.length > 0 && zerionQuery.isSuccess,
    staleTime: 30_000, // 30 seconds
  });

  // Combine tokens: Zerion first, then extra tokens (deduplicated)
  // Importantly, we show zerion tokens immediately without waiting for extra tokens
  const tokens = React.useMemo(() => {
    const zerionTokens = zerionQuery.data ?? [];

    // Only include extra tokens if the query has successfully completed
    // This ensures zerion data renders first before extra tokens are added
    if (!extraQuery.isSuccess) {
      // Sort by USD value (descending)
      const sorted = [...zerionTokens];
      sorted.sort((a, b) => getTokenAmountInUsd(b) - getTokenAmountInUsd(a));
      return sorted;
    }

    const extraTokens = extraQuery.data ?? [];

    // Deduplicate extra tokens against Zerion tokens
    const deduplicatedExtra = extraTokens.filter((extra) => !zerionTokens.some((zerion) => isSameToken(zerion, extra)));

    const combined = [...zerionTokens, ...deduplicatedExtra];
    // Sort by USD value (descending)
    combined.sort((a, b) => getTokenAmountInUsd(b) - getTokenAmountInUsd(a));
    return combined;
  }, [zerionQuery.data, extraQuery.data, extraQuery.isSuccess]);

  const isLoading = zerionQuery.isLoading;
  const isRefreshing = zerionQuery.isFetching || extraQuery.isFetching;
  const error = zerionQuery.error?.message ?? extraQuery.error?.message ?? null;

  const handleRefresh = React.useCallback(() => {
    setRowSelection({});
    zerionQuery.refetch();
    extraQuery.refetch();
  }, [zerionQuery.refetch, extraQuery.refetch]);

  const zerionApiKeyMissing = !import.meta.env.VITE_ZERION_API_KEY;

  return (
    <div className="space-y-4">
      {zerionApiKeyMissing && (
        <div className="p-4 text-muted-foreground rounded-md bg-muted border border-border">
          VITE_ZERION_API_KEY is not set — showing native coin balances only. Set the API key to see all tokens.
        </div>
      )}
      {error && <div className="p-4 text-red-700 rounded-md bg-red-50">{error}</div>}
      {tokens.length > 0 || isLoading ? (
        <>
          <DataTable
            columns={columns}
            data={tokens}
            connectedAddresses={connectedAddresses}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            onRefresh={handleRefresh}
            isRefreshing={isRefreshing || isLoading}
          />
          <div className="flex justify-center mt-6">
            <ConsolidateTokensModal
              tokens={tokens}
              rowSelection={rowSelection}
              selectedRows={Object.keys(rowSelection).length}
              onComplete={handleRefresh}
            />
          </div>
        </>
      ) : (
        <EmptyState hasAddresses={connectedAddresses.length > 0} />
      )}
    </div>
  );
}
