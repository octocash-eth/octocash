import {
  PaginationNav,
  type PaginationNavProps,
  PaginationSize,
  type PaginationSizeProps,
} from "~/components/ui/pagination";
import { useDataGrid } from "./data-grid";

type DataGridPaginationSizeProps = Omit<PaginationSizeProps, "pageSize" | "onPageSizeChange" | "isLoading"> & {
  sizes?: number[];
};

function DataGridPaginationSize({ sizes = [5, 10, 25, 50, 100], ...props }: DataGridPaginationSizeProps) {
  const { table, isLoading } = useDataGrid();

  return (
    <PaginationSize
      sizes={sizes}
      {...props}
      pageSize={table.state.pagination.pageSize}
      onPageSizeChange={(s) => table.setPageSize(s)}
      isLoading={isLoading}
    />
  );
}

type DataGridPaginationNavProps = Omit<PaginationNavProps, "pageIndex" | "pageCount" | "onPageChange" | "isLoading">;

function DataGridPaginationNav(props: DataGridPaginationNavProps) {
  const { table, isLoading } = useDataGrid();

  return (
    <PaginationNav
      {...props}
      pageIndex={table.state.pagination.pageIndex}
      pageCount={table.getPageCount()}
      onPageChange={(i) => table.setPageIndex(i)}
      isLoading={isLoading}
    />
  );
}

export { DataGridPaginationNav, DataGridPaginationSize };
