import { useDataGrid } from "~/components/ui/data-grid";
import {
  Pagination,
  PaginationNav,
  type PaginationNavProps,
  type PaginationProps,
  PaginationSize,
  type PaginationSizeProps,
} from "~/components/ui/pagination";

type DataGridPaginationSizeProps = Omit<PaginationSizeProps, "pageSize" | "onPageSizeChange" | "isLoading"> & {
  sizes?: number[];
};

function DataGridPaginationSize({ sizes = [5, 10, 25, 50, 100], ...props }: DataGridPaginationSizeProps) {
  const { table, isLoading } = useDataGrid();
  const pageSize = table.getState().pagination.pageSize;

  return (
    <PaginationSize
      sizes={sizes}
      {...props}
      pageSize={pageSize}
      onPageSizeChange={(s) => table.setPageSize(s)}
      isLoading={isLoading}
    />
  );
}

type DataGridPaginationNavProps = Omit<PaginationNavProps, "pageIndex" | "pageCount" | "onPageChange" | "isLoading">;

function DataGridPaginationNav(props: DataGridPaginationNavProps) {
  const { table, isLoading } = useDataGrid();
  const pageIndex = table.getState().pagination.pageIndex;
  const pageCount = table.getPageCount();

  return (
    <PaginationNav
      {...props}
      pageIndex={pageIndex}
      pageCount={pageCount}
      onPageChange={(i) => table.setPageIndex(i)}
      isLoading={isLoading}
    />
  );
}

type DataGridPaginationProps = Omit<
  PaginationProps,
  "pageIndex" | "pageSize" | "pageCount" | "onPageChange" | "onPageSizeChange" | "isLoading"
> & {
  sizes?: number[];
};

function DataGridPagination(props: DataGridPaginationProps) {
  const { table, isLoading } = useDataGrid();
  const pageIndex = table.getState().pagination.pageIndex;
  const pageSize = table.getState().pagination.pageSize;
  const pageCount = table.getPageCount();

  return (
    <Pagination
      sizes={[5, 10, 25, 50, 100]}
      {...props}
      pageIndex={pageIndex}
      pageSize={pageSize}
      pageCount={pageCount}
      isLoading={isLoading}
      onPageChange={(i) => table.setPageIndex(i)}
      onPageSizeChange={(s) => table.setPageSize(s)}
    />
  );
}

export {
  DataGridPagination,
  DataGridPaginationNav,
  type DataGridPaginationNavProps,
  type DataGridPaginationProps,
  DataGridPaginationSize,
  type DataGridPaginationSizeProps,
};
