import type { CellData } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useDataGrid } from "./data-grid";
import type { WalletColumn } from "./features";

interface DataGridColumnHeaderProps<TValue extends CellData> {
  column: WalletColumn<TValue>;
  title?: string;
  className?: string;
}

/**
 * Column header label that cycles the column's sort (asc → desc → unsorted)
 * on click. Columns that can't sort render a plain label.
 */
function DataGridColumnHeader<TValue extends CellData>({
  column,
  title = "",
  className,
}: DataGridColumnHeaderProps<TValue>) {
  const { isLoading, recordCount } = useDataGrid();

  if (!column.getCanSort()) {
    return (
      <div
        className={cn(
          "text-foreground font-normal inline-flex h-full items-center gap-1.5 text-[0.8125rem] leading-[calc(1.125/0.8125)] [&_svg]:size-3.5 [&_svg]:opacity-60",
          className,
        )}
      >
        {title}
      </div>
    );
  }

  const isSorted = column.getIsSorted();

  return (
    <div className="flex items-center h-full">
      <Button
        variant="ghost"
        className={cn(
          "text-foreground rounded-full font-normal -ms-2 px-2 h-7 hover:bg-muted hover:text-muted-foreground data-[state=open]:bg-muted data-[state=open]:text-muted-foreground",
          className,
        )}
        disabled={isLoading || recordCount === 0}
        onClick={() => {
          if (isSorted === "asc") {
            column.toggleSorting(true);
          } else if (isSorted === "desc") {
            column.clearSorting();
          } else {
            column.toggleSorting(false);
          }
        }}
      >
        {title}
        {isSorted === "desc" ? (
          <ArrowDown className="size-[0.7rem]! mt-px" />
        ) : isSorted === "asc" ? (
          <ArrowUp className="size-[0.7rem]! mt-px" />
        ) : (
          <ChevronsUpDown className="size-[0.7rem]! mt-px" />
        )}
      </Button>
    </div>
  );
}

export { DataGridColumnHeader };
