import { useDataGrid } from "~/components/ui/data-grid";
import { Pagination, type PaginationProps } from "~/components/ui/pagination";

type DataGridPaginationProps = Omit<
  PaginationProps,
  "pageIndex" | "pageSize" | "pageCount" | "recordCount" | "onPageChange" | "onPageSizeChange" | "isLoading"
> & {
  sizes?: number[];
};

function DataGridPagination(props: DataGridPaginationProps) {
  const { table, recordCount, isLoading } = useDataGrid();
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
      recordCount={recordCount}
      isLoading={isLoading}
      onPageChange={(i) => table.setPageIndex(i)}
      onPageSizeChange={(s) => table.setPageSize(s)}
    />
  );
}

export { DataGridPagination, type DataGridPaginationProps };
