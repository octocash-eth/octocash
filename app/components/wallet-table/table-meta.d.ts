import "@tanstack/react-table";
import type { RowData } from "@tanstack/react-table";

declare module "@tanstack/react-table" {
  interface TableMeta<TData extends RowData> {
    priceFor?: (row: TData) => number | undefined;
    isPending?: (row: TData) => boolean;
  }
}
