import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

interface PaginationProps {
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  recordCount: number;
  onPageChange: (index: number) => void;
  sizes?: number[];
  onPageSizeChange?: (size: number) => void;
  moreLimit?: number;
  info?: string;
  rowsPerPageLabel?: string;
  previousPageLabel?: string;
  nextPageLabel?: string;
  ellipsisText?: string;
  className?: string;
  isLoading?: boolean;
  sizesSkeleton?: ReactNode;
  infoSkeleton?: ReactNode;
}

function Pagination({
  pageIndex,
  pageSize,
  pageCount,
  recordCount,
  onPageChange,
  sizes,
  onPageSizeChange,
  moreLimit = 5,
  info = "{from} - {to} of {count}",
  rowsPerPageLabel = "Rows per page",
  previousPageLabel = "Go to previous page",
  nextPageLabel = "Go to next page",
  ellipsisText = "...",
  className,
  isLoading = false,
  sizesSkeleton = <Skeleton className="h-8 w-44" />,
  infoSkeleton = <Skeleton className="h-8 w-60" />,
}: PaginationProps) {
  const btnBaseClasses = "size-7 p-0 text-sm";
  const btnArrowClasses = `${btnBaseClasses} rtl:transform rtl:rotate-180`;

  const from = recordCount > 0 ? pageIndex * pageSize + 1 : 0;
  const to = Math.min((pageIndex + 1) * pageSize, recordCount);

  const paginationInfo = info
    .replace("{from}", from.toString())
    .replace("{to}", to.toString())
    .replace("{count}", recordCount.toString());

  const currentGroupStart = Math.floor(pageIndex / moreLimit) * moreLimit;
  const currentGroupEnd = Math.min(currentGroupStart + moreLimit, pageCount);

  const showSizeSelector = sizes && sizes.length > 0 && onPageSizeChange;

  const renderPageButtons = () => {
    const buttons = [];
    for (let i = currentGroupStart; i < currentGroupEnd; i++) {
      buttons.push(
        <Button
          key={`page-${i + 1}`}
          size="icon"
          variant="ghost"
          className={cn(btnBaseClasses, "text-muted-foreground", {
            "bg-accent text-accent-foreground": pageIndex === i,
          })}
          onClick={() => {
            if (pageIndex !== i) onPageChange(i);
          }}
        >
          {i + 1}
        </Button>,
      );
    }
    return buttons;
  };

  return (
    <div
      data-slot="pagination"
      className={cn(
        "flex flex-wrap flex-col sm:flex-row justify-between items-center gap-2.5 py-2.5 sm:py-0 grow",
        className,
      )}
    >
      <div className="flex flex-wrap items-center space-x-2.5 pb-2.5 sm:pb-0 order-2 sm:order-1">
        {isLoading ? (
          showSizeSelector ? (
            sizesSkeleton
          ) : null
        ) : showSizeSelector ? (
          <>
            <div className="text-sm text-muted-foreground">{rowsPerPageLabel}</div>
            <Select value={`${pageSize}`} onValueChange={(value) => onPageSizeChange?.(Number(value))}>
              <SelectTrigger className="w-fit" size="sm">
                <SelectValue placeholder={`${pageSize}`} />
              </SelectTrigger>
              <SelectContent side="top" className="min-w-[50px]">
                {sizes?.map((size) => (
                  <SelectItem key={size} value={`${size}`}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : null}
      </div>
      <div className="flex flex-col sm:flex-row justify-center sm:justify-end items-center gap-2.5 pt-2.5 sm:pt-0 order-1 sm:order-2">
        {isLoading ? (
          infoSkeleton
        ) : (
          <>
            <div className="text-sm text-muted-foreground text-nowrap order-2 sm:order-1">{paginationInfo}</div>
            {pageCount > 1 && (
              <div className="flex items-center space-x-1 order-1 sm:order-2">
                <Button
                  size="icon"
                  variant="ghost"
                  className={btnArrowClasses}
                  onClick={() => onPageChange(pageIndex - 1)}
                  disabled={pageIndex === 0}
                >
                  <span className="sr-only">{previousPageLabel}</span>
                  <ChevronLeftIcon className="size-4" />
                </Button>

                {currentGroupStart > 0 && (
                  <Button
                    size="icon"
                    className={btnBaseClasses}
                    variant="ghost"
                    onClick={() => onPageChange(currentGroupStart - 1)}
                  >
                    {ellipsisText}
                  </Button>
                )}

                {renderPageButtons()}

                {currentGroupEnd < pageCount && (
                  <Button
                    size="icon"
                    className={btnBaseClasses}
                    variant="ghost"
                    onClick={() => onPageChange(currentGroupEnd)}
                  >
                    {ellipsisText}
                  </Button>
                )}

                <Button
                  size="icon"
                  variant="ghost"
                  className={btnArrowClasses}
                  onClick={() => onPageChange(pageIndex + 1)}
                  disabled={pageIndex >= pageCount - 1}
                >
                  <span className="sr-only">{nextPageLabel}</span>
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export { Pagination, type PaginationProps };
