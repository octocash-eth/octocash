import { flexRender } from "@tanstack/react-table";
import { cva } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { useDataGrid } from "./data-grid";
import type { WalletHeader, WalletHeaderGroup, WalletRow } from "./features";

const headerCellSpacingVariants = cva("px-2.5 h-9 md:px-4");

const bodyCellSpacingVariants = cva("px-2.5 py-2 md:px-4 md:py-3");

function DataGridTableBase({ children }: { children: ReactNode }) {
  const { props } = useDataGrid();

  return (
    <table
      data-slot="data-grid-table"
      className={cn(
        "w-full align-middle caption-bottom text-left rtl:text-right text-foreground font-normal text-sm",
        "border-separate border-spacing-0",
        props.tableLayout?.width === "fixed" ? "table-fixed" : "table-auto",
        props.tableClassNames?.base,
      )}
    >
      {children}
    </table>
  );
}

function DataGridTableHead({ children }: { children: ReactNode }) {
  const { props } = useDataGrid();

  return (
    <thead
      className={cn(
        props.tableClassNames?.header,
        props.tableLayout?.headerSticky && props.tableClassNames?.headerSticky,
      )}
    >
      {children}
    </thead>
  );
}

function DataGridTableHeadRow({ children, headerGroup }: { children: ReactNode; headerGroup: WalletHeaderGroup }) {
  const { props } = useDataGrid();

  return (
    <tr
      key={headerGroup.id}
      className={cn(
        "bg-muted/40",
        props.tableLayout?.headerBorder && "[&>th]:border-b",
        props.tableLayout?.cellBorder && "[&_>:last-child]:border-e-0",
        props.tableLayout?.striped && "bg-transparent",
        props.tableLayout?.headerBackground === false && "bg-transparent",
        props.tableClassNames?.headerRow,
      )}
    >
      {children}
    </tr>
  );
}

function DataGridTableHeadRowCell({ children, header }: { children: ReactNode; header: WalletHeader }) {
  const { props } = useDataGrid();

  return (
    <th
      key={header.id}
      style={props.tableLayout?.width === "fixed" ? { width: `${header.getSize()}px` } : undefined}
      className={cn(
        "relative h-10 text-left rtl:text-right align-middle font-normal text-secondary-foreground/80 [&:has([role=checkbox])]:pe-0",
        headerCellSpacingVariants(),
        props.tableLayout?.cellBorder && "border-e",
      )}
    >
      {children}
    </th>
  );
}

function DataGridTableRowSpacer() {
  return <tbody aria-hidden="true" className="h-2"></tbody>;
}

function DataGridTableBody({ children }: { children: ReactNode }) {
  const { props } = useDataGrid();

  return (
    <tbody
      className={cn(
        "[&_tr:last-child]:border-0",
        props.tableLayout?.rowRounded && "[&_td:first-child]:rounded-s-lg [&_td:last-child]:rounded-e-lg",
        props.tableClassNames?.body,
      )}
    >
      {children}
    </tbody>
  );
}

function useBodyRowClassName() {
  const { props, table } = useDataGrid();

  return cn(
    "hover:bg-muted/40 data-[state=selected]:bg-muted/50",
    props.onRowClick && "cursor-pointer",
    !props.tableLayout?.striped &&
      props.tableLayout?.rowBorder &&
      "border-b border-border [&:not(:last-child)>td]:border-b",
    props.tableLayout?.cellBorder && "[&_>:last-child]:border-e-0",
    props.tableLayout?.striped && "odd:bg-muted/90 hover:bg-transparent odd:hover:bg-muted",
    table.options.enableRowSelection && "[&_>:first-child]:relative",
    props.tableClassNames?.bodyRow,
  );
}

function DataGridTableBodyRow({ children, row }: { children: ReactNode; row: WalletRow }) {
  const { props, table } = useDataGrid();

  return (
    <tr
      data-state={table.options.enableRowSelection && row.getIsSelected() ? "selected" : undefined}
      onClick={() => props.onRowClick?.(row)}
      className={useBodyRowClassName()}
    >
      {children}
    </tr>
  );
}

function DataGridTableBodyCell({ children }: { children: ReactNode }) {
  const { props } = useDataGrid();

  return (
    <td className={cn("align-middle", bodyCellSpacingVariants(), props.tableLayout?.cellBorder && "border-e")}>
      {children}
    </td>
  );
}

function DataGridTableEmpty() {
  const { table, props } = useDataGrid();

  return (
    <tr>
      <td colSpan={table.getAllLeafColumns().length} className="text-center text-muted-foreground py-6">
        {props.emptyMessage || "No data available"}
      </td>
    </tr>
  );
}

function DataGridTableSkeletonRows() {
  const { table } = useDataGrid();
  const rowClassName = useBodyRowClassName();
  const columns = table.getAllLeafColumns();

  return Array.from({ length: table.state.pagination.pageSize }).map((_, rowIndex) => (
    <tr className={rowClassName} key={`skeleton-row-${rowIndex}`}>
      {columns.map((column) => (
        <DataGridTableBodyCell key={`skeleton-cell-${column.id}`}>
          {column.columnDef.meta?.skeleton}
        </DataGridTableBodyCell>
      ))}
    </tr>
  ));
}

function DataGridTable() {
  const { table, isLoading, props } = useDataGrid();
  const rows = table.getRowModel().rows;

  return (
    <DataGridTableBase>
      <DataGridTableHead>
        {table.getHeaderGroups().map((headerGroup) => (
          <DataGridTableHeadRow headerGroup={headerGroup} key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <DataGridTableHeadRowCell header={header} key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </DataGridTableHeadRowCell>
            ))}
          </DataGridTableHeadRow>
        ))}
      </DataGridTableHead>

      {(props.tableLayout?.striped || !props.tableLayout?.rowBorder) && <DataGridTableRowSpacer />}

      <DataGridTableBody>
        {isLoading ? (
          <DataGridTableSkeletonRows />
        ) : rows.length ? (
          rows.map((row) => (
            <DataGridTableBodyRow row={row} key={row.id}>
              {row.getAllCells().map((cell) => (
                <DataGridTableBodyCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </DataGridTableBodyCell>
              ))}
            </DataGridTableBodyRow>
          ))
        ) : (
          <DataGridTableEmpty />
        )}
      </DataGridTableBody>
    </DataGridTableBase>
  );
}

export { DataGridTable };
