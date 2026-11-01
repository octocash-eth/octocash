"use client";

import { createContext, type ReactNode, useContext } from "react";
import { cn } from "~/lib/utils";
import type { WalletRow, WalletTable } from "./features";

export interface DataGridProps {
  className?: string;
  table: WalletTable;
  recordCount: number;
  children?: ReactNode;
  onRowClick?: (row: WalletRow) => void;
  isLoading?: boolean;
  emptyMessage?: ReactNode | string;
  tableLayout?: {
    cellBorder?: boolean;
    rowBorder?: boolean;
    rowRounded?: boolean;
    striped?: boolean;
    headerBackground?: boolean;
    headerBorder?: boolean;
    headerSticky?: boolean;
    width?: "auto" | "fixed";
  };
  tableClassNames?: {
    base?: string;
    header?: string;
    headerRow?: string;
    headerSticky?: string;
    body?: string;
    bodyRow?: string;
  };
}

interface DataGridContextProps {
  props: Omit<DataGridProps, "table" | "children">;
  table: WalletTable;
  recordCount: number;
  isLoading: boolean;
}

const DataGridContext = createContext<DataGridContextProps | undefined>(undefined);

function useDataGrid() {
  const context = useContext(DataGridContext);
  if (!context) {
    throw new Error("useDataGrid must be used within a DataGrid");
  }
  return context;
}

const defaultTableLayout: NonNullable<DataGridProps["tableLayout"]> = {
  cellBorder: false,
  rowBorder: true,
  rowRounded: false,
  striped: false,
  headerSticky: false,
  headerBackground: true,
  headerBorder: true,
  width: "fixed",
};

const defaultTableClassNames: NonNullable<DataGridProps["tableClassNames"]> = {
  base: "",
  header: "",
  headerRow: "",
  headerSticky: "sticky top-0 z-10 bg-background/90 backdrop-blur-xs",
  body: "",
  bodyRow: "",
};

function DataGrid({ children, table, ...props }: DataGridProps) {
  const mergedProps: DataGridContextProps["props"] = {
    ...props,
    tableLayout: { ...defaultTableLayout, ...props.tableLayout },
    tableClassNames: { ...defaultTableClassNames, ...props.tableClassNames },
  };

  return (
    <DataGridContext.Provider
      value={{
        props: mergedProps,
        table,
        recordCount: props.recordCount,
        isLoading: props.isLoading || false,
      }}
    >
      {children}
    </DataGridContext.Provider>
  );
}

function DataGridContainer({
  children,
  className,
  border = true,
}: {
  children: ReactNode;
  className?: string;
  border?: boolean;
}) {
  return (
    <div data-slot="data-grid" className={cn("grid w-full", border && "border border-border rounded-lg", className)}>
      {children}
    </div>
  );
}

export { DataGrid, DataGridContainer, useDataGrid };
