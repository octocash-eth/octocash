import type { RowSelectionState } from "@tanstack/react-table";
import * as React from "react";
import { ConsolidateTokensModal } from "~/components/consolidate-tokens-modal";
import { fetchTokenBalances } from "~/lib/api";
import { formatTokenAmount, getTokenAmountInUsd } from "~/lib/tokens";
import type { TokenAmount } from "~/lib/types";
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
  const [tokens, setTokens] = React.useState<TokenAmount[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  const loadTokenBalances = React.useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (connectedAddresses.length === 0) {
        setTokens([]);
        setIsLoading(false);
        setIsRefreshing(false);
        return;
      }

      if (mode === "initial") {
        setIsLoading(true);
      } else {
        setIsRefreshing(true);
      }

      setError(null);

      try {
        const addresses = Array.from(connectedAddresses);

        console.log(`Fetching token balances for ${addresses.length} addresses across different networks...`);
        const data = await fetchTokenBalances(addresses);
        console.log(`Received ${data.length} tokens from API`);

        if (data.length > 0) {
          const filteredData = data.filter(
            (token) => Number(formatTokenAmount(token)) > 0.000001 && getTokenAmountInUsd(token) > 0,
          );
          console.log(
            `After filtering, ${filteredData.length} tokens remain with non-zero balances and monetary value`,
          );
          setTokens(filteredData);
        } else {
          console.log("No tokens returned from API, using empty array");
          setTokens([]);
        }
      } catch (err) {
        console.error("Failed to fetch token balances:", err);
        setError("Failed to load token balances.");
        setTokens([]);
      } finally {
        if (mode === "initial") {
          setIsLoading(false);
        } else {
          setIsRefreshing(false);
        }
      }
    },
    [connectedAddresses],
  );

  // Fetch token balances when component mounts or when connectedAddresses changes
  React.useEffect(() => {
    void loadTokenBalances("initial");
  }, [loadTokenBalances]);

  return (
    <div className="space-y-4">
      {error && <div className="p-4 text-red-700 rounded-md bg-red-50">{error}</div>}
      {tokens.length > 0 || isLoading ? (
        <>
          <DataTable
            columns={columns}
            data={tokens}
            connectedAddresses={connectedAddresses}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            onRefresh={() => {
              setRowSelection({});
              void loadTokenBalances("refresh");
            }}
            isRefreshing={isRefreshing || isLoading}
          />
          <div className="flex justify-center mt-6">
            <ConsolidateTokensModal
              tokens={tokens}
              rowSelection={rowSelection}
              selectedRows={Object.keys(rowSelection).length}
              onComplete={() => {
                setRowSelection({});
                void loadTokenBalances("refresh");
              }}
            />
          </div>
        </>
      ) : (
        <EmptyState hasAddresses={connectedAddresses.length > 0} />
      )}
    </div>
  );
}
