import {
  type Column,
  columnFilteringFeature,
  columnSizingFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  type Header,
  type HeaderGroup,
  metaHelper,
  type ReactTable,
  type Row,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
} from "@tanstack/react-table";
import type { ReactNode } from "react";
import type { TokenAmount } from "~/lib/types";

export interface WalletTableMeta {
  priceFor?: (row: TokenAmount) => number | undefined;
  isPending?: (row: TokenAmount) => boolean;
  canSelectMore?: boolean;
}

export interface WalletColumnMeta {
  /** Placeholder rendered in this column's cells while the table is loading. */
  skeleton?: ReactNode;
}

/**
 * Everything the wallet table registers with TanStack Table v9: the features
 * its grid calls into (column sizing gives the fixed column widths), the
 * client-side row models, the sort functions `"auto"` can resolve to for its
 * columns, and its table/column meta types.
 */
export const walletTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnSizingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic, text: sortFn_text },
  tableMeta: metaHelper<WalletTableMeta>(),
  columnMeta: metaHelper<WalletColumnMeta>(),
});

export type WalletTableFeatures = typeof walletTableFeatures;
export type WalletTable = ReactTable<WalletTableFeatures, TokenAmount>;
export type WalletRow = Row<WalletTableFeatures, TokenAmount>;
export type WalletColumn = Column<WalletTableFeatures, TokenAmount>;
export type WalletHeader = Header<WalletTableFeatures, TokenAmount, unknown>;
export type WalletHeaderGroup = HeaderGroup<WalletTableFeatures, TokenAmount>;
