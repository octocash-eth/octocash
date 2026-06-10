import { ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

interface PaginationSizeProps {
  pageSize: number;
  sizes: number[];
  onPageSizeChange: (size: number) => void;
  label?: string;
  className?: string;
  isLoading?: boolean;
  skeleton?: ReactNode;
}

function PaginationSize({
  pageSize,
  sizes,
  onPageSizeChange,
  label = "Rows per page",
  className,
  isLoading = false,
  skeleton = <Skeleton className="h-8 w-44" />,
}: PaginationSizeProps) {
  if (isLoading) return <>{skeleton}</>;
  if (sizes.length === 0) return null;

  return (
    <div data-slot="pagination-size" className={cn("flex items-center gap-2", className)}>
      <p className="text-sm font-medium">{label}</p>
      <Select value={`${pageSize}`} onValueChange={(value) => onPageSizeChange(Number(value))}>
        <SelectTrigger className="w-fit" size="sm">
          <SelectValue placeholder={`${pageSize}`} />
        </SelectTrigger>
        <SelectContent side="top" className="min-w-[50px]">
          {sizes.map((size) => (
            <SelectItem key={size} value={`${size}`}>
              {size}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface PaginationNavProps {
  pageIndex: number;
  pageCount: number;
  onPageChange: (index: number) => void;
  firstPageLabel?: string;
  previousPageLabel?: string;
  nextPageLabel?: string;
  lastPageLabel?: string;
  className?: string;
  isLoading?: boolean;
  skeleton?: ReactNode;
}

function PaginationNav({
  pageIndex,
  pageCount,
  onPageChange,
  firstPageLabel = "Go to first page",
  previousPageLabel = "Go to previous page",
  nextPageLabel = "Go to next page",
  lastPageLabel = "Go to last page",
  className,
  isLoading = false,
  skeleton = <Skeleton className="h-8 w-60" />,
}: PaginationNavProps) {
  if (isLoading) return <>{skeleton}</>;

  const canPrev = pageIndex > 0;
  const canNext = pageIndex < pageCount - 1;
  const displayPageCount = Math.max(pageCount, 1);

  return (
    <div data-slot="pagination-nav" className={cn("flex items-center gap-2", className)}>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8 rtl:rotate-180"
        onClick={() => onPageChange(0)}
        disabled={!canPrev}
      >
        <span className="sr-only">{firstPageLabel}</span>
        <ChevronsLeftIcon className="size-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8 rtl:rotate-180"
        onClick={() => onPageChange(pageIndex - 1)}
        disabled={!canPrev}
      >
        <span className="sr-only">{previousPageLabel}</span>
        <ChevronLeftIcon className="size-4" />
      </Button>
      <div className="flex w-[100px] items-center justify-center text-sm font-medium">
        Page {pageIndex + 1} of {displayPageCount}
      </div>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8 rtl:rotate-180"
        onClick={() => onPageChange(pageIndex + 1)}
        disabled={!canNext}
      >
        <span className="sr-only">{nextPageLabel}</span>
        <ChevronRightIcon className="size-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-8 w-8 rtl:rotate-180"
        onClick={() => onPageChange(pageCount - 1)}
        disabled={!canNext}
      >
        <span className="sr-only">{lastPageLabel}</span>
        <ChevronsRightIcon className="size-4" />
      </Button>
    </div>
  );
}

interface PaginationProps
  extends Omit<PaginationNavProps, "className" | "skeleton">,
    Omit<PaginationSizeProps, "className" | "skeleton" | "label" | "sizes" | "onPageSizeChange"> {
  sizes?: number[];
  onPageSizeChange?: (size: number) => void;
  rowsPerPageLabel?: string;
  className?: string;
  sizesSkeleton?: ReactNode;
  navSkeleton?: ReactNode;
}

function Pagination({
  pageIndex,
  pageSize,
  pageCount,
  onPageChange,
  sizes,
  onPageSizeChange,
  rowsPerPageLabel,
  firstPageLabel,
  previousPageLabel,
  nextPageLabel,
  lastPageLabel,
  className,
  isLoading = false,
  sizesSkeleton,
  navSkeleton,
}: PaginationProps) {
  const showSize = sizes && sizes.length > 0 && onPageSizeChange;

  return (
    <div
      data-slot="pagination"
      className={cn("flex flex-wrap items-center justify-center gap-x-6 gap-y-2.5 py-2.5 sm:py-0", className)}
    >
      {showSize ? (
        <PaginationSize
          pageSize={pageSize}
          sizes={sizes}
          onPageSizeChange={onPageSizeChange}
          label={rowsPerPageLabel}
          isLoading={isLoading}
          skeleton={sizesSkeleton}
        />
      ) : null}
      <PaginationNav
        pageIndex={pageIndex}
        pageCount={pageCount}
        onPageChange={onPageChange}
        firstPageLabel={firstPageLabel}
        previousPageLabel={previousPageLabel}
        nextPageLabel={nextPageLabel}
        lastPageLabel={lastPageLabel}
        isLoading={isLoading}
        skeleton={navSkeleton}
      />
    </div>
  );
}

export {
  Pagination,
  PaginationNav,
  type PaginationNavProps,
  type PaginationProps,
  PaginationSize,
  type PaginationSizeProps,
};
