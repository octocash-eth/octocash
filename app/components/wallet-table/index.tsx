import type { RowSelectionState } from "@tanstack/react-table";
import * as React from "react";
import { ConsolidateTokensModal } from "~/components/consolidate-tokens-modal";
import { fetchTokenBalances } from "~/lib/api";
import type { WalletData } from "./columns";
import { columns } from "./columns";
import { DataTable } from "./data-table";

interface WalletTableProps {
  connectedAddresses?: readonly string[];
}

export function WalletTable({ connectedAddresses = [] }: WalletTableProps) {
  const [walletData, setWalletData] = React.useState<WalletData[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [consolidateAmounts, setConsolidateAmounts] = React.useState<Record<string, string>>({});

  // Calculate the total value to consolidate
  const totalValueToConsolidate = React.useMemo(() => {
    let total = 0;

    Object.entries(rowSelection).forEach(([rowId, isSelected]) => {
      if (isSelected && walletData[parseInt(rowId)]) {
        const row = walletData[parseInt(rowId)];
        const amount = consolidateAmounts[rowId] !== undefined ? consolidateAmounts[rowId] : row.amount;
        // Calculate the USD value based on the proportion of tokens being consolidated
        const proportion = Number(amount) / Number(row.amount);
        total += row.amountInUsd * proportion;
      }
    });

    return total;
  }, [walletData, rowSelection, consolidateAmounts]);

  // Listen for amount to consolidate changes
  React.useEffect(() => {
    const handleAmountChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ rowId: string; value: string }>;
      const { rowId, value } = customEvent.detail;

      setConsolidateAmounts((prev) => ({
        ...prev,
        [rowId]: String(value),
      }));
    };

    document.addEventListener("amountToConsolidateChange", handleAmountChange as EventListener);

    return () => {
      document.removeEventListener("amountToConsolidateChange", handleAmountChange as EventListener);
    };
  }, []);

  // Initialize consolidate amounts when rows are selected
  React.useEffect(() => {
    setConsolidateAmounts((previous) => {
      let hasChanges = false;
      const next: Record<string, string> = { ...previous };

      Object.entries(rowSelection).forEach(([rowId, isSelected]) => {
        if (isSelected && walletData[parseInt(rowId)]) {
          if (next[rowId] === undefined) {
            next[rowId] = walletData[parseInt(rowId)].amount;
            hasChanges = true;
          }
        }
      });

      return hasChanges ? next : previous;
    });
  }, [rowSelection, walletData]);

  const loadTokenBalances = React.useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (connectedAddresses.length === 0) {
        setWalletData([]);
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
          const filteredData = data.filter((item) => Number(item.amount) > 0.000001 && Number(item.amountInUsd) > 0);
          console.log(
            `After filtering, ${filteredData.length} tokens remain with non-zero balances and monetary value`,
          );
          setWalletData(filteredData);
        } else {
          console.log("No tokens returned from API, using empty array");
          setWalletData([]);
        }
      } catch (err) {
        console.error("Failed to fetch token balances:", err);
        setError("Failed to load token balances.");
        setWalletData([]);
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

  // Empty state component
  const EmptyState = () => (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <p className="mb-2 text-muted-foreground">No tokens found</p>
      <p className="text-sm text-muted-foreground">
        {connectedAddresses.length > 0
          ? "Connect a wallet with tokens or try a different address"
          : "Connect a wallet to see your tokens"}
      </p>
    </div>
  );

  return (
    <div className="space-y-4">
      {error && <div className="p-4 text-red-700 rounded-md bg-red-50">{error}</div>}
      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-b-2 rounded-full animate-spin border-primary"></div>
        </div>
      ) : walletData.length > 0 ? (
        <>
          <DataTable
            columns={columns}
            data={walletData}
            connectedAddresses={connectedAddresses}
            onRowSelectionChange={setRowSelection}
            onRefresh={() => {
              void loadTokenBalances("refresh");
            }}
            isRefreshing={isRefreshing}
          />
          <div className="flex justify-center mt-6">
            <ConsolidateTokensModal
              walletData={walletData}
              rowSelection={rowSelection}
              selectedRows={Object.keys(rowSelection).length}
              consolidateAmounts={consolidateAmounts}
              totalValueToConsolidate={totalValueToConsolidate}
            />
          </div>
        </>
      ) : (
        <EmptyState />
      )}
    </div>
  );
}
