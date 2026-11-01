import type { LucideIcon } from "lucide-react";
import { Filter } from "lucide-react";

import { Button } from "../ui/button";
import type { WalletTable } from "./features";
import { FilterDropdown, type FilterOption } from "./filter-dropdown";

export interface WalletTableFilterConfig {
  /** Column whose `isAnyOf` filter this dropdown drives. */
  columnId: string;
  label: string;
  icon: LucideIcon;
  emptyMessage: string;
  options: readonly FilterOption[];
}

interface WalletTableFiltersProps {
  table: WalletTable;
  filterConfigs: readonly WalletTableFilterConfig[];
}

/** The values currently selected in a column's `isAnyOf` filter. */
function selectedValues(filterValue: unknown): string[] {
  return Array.isArray(filterValue) ? filterValue.filter((value): value is string => typeof value === "string") : [];
}

/**
 * Multi-select dropdowns over the table's own column filters. The table is
 * the single source of truth for what's selected; every change also sends
 * the user back to page 1, since the table keeps `autoResetPageIndex` off.
 */
export function WalletTableFilters({ table, filterConfigs }: WalletTableFiltersProps) {
  const { columnFilters } = table.state;
  const hasActiveFilters = columnFilters.length > 0;

  const setColumnValues = (columnId: string, update: (current: string[]) => string[]) => {
    // An empty selection is dropped by the filter's `autoRemove`.
    table.getColumn(columnId)?.setFilterValue((previous: unknown) => update(selectedValues(previous)));
    table.setPageIndex(0);
  };

  const onClearAll = () => {
    table.resetColumnFilters(true);
    table.setPageIndex(0);
  };

  return (
    <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:items-center md:gap-2 md:flex-1">
      {/* Mobile: top line with the "Filter by" label and "Clear all".
          Desktop: `contents` dissolves this wrapper so the children sit inline. */}
      <div className="flex items-center gap-2 md:contents">
        <span className="text-sm font-medium">
          <Filter className="h-4 w-4 inline-block mr-1" />
          Filter by
        </span>

        <Button
          disabled={!hasActiveFilters}
          variant="ghost"
          size="sm"
          onClick={onClearAll}
          className="text-xs md:order-last"
        >
          Clear all
        </Button>
      </div>

      {/* Mobile: bottom line with the filter dropdowns.
          Desktop: `contents` dissolves this wrapper so dropdowns sit inline. */}
      <div className="flex items-center gap-2 flex-wrap md:contents">
        {filterConfigs.map((config) => (
          <FilterDropdown
            key={config.columnId}
            icon={config.icon}
            label={config.label}
            selectedValues={selectedValues(columnFilters.find((filter) => filter.id === config.columnId)?.value)}
            options={config.options}
            onToggle={(value, isSelected) =>
              setColumnValues(config.columnId, (current) =>
                isSelected
                  ? current.includes(value)
                    ? current
                    : [...current, value]
                  : current.filter((item) => item !== value),
              )
            }
            onClear={() => setColumnValues(config.columnId, () => [])}
            emptyMessage={config.emptyMessage}
          />
        ))}
      </div>
    </div>
  );
}
