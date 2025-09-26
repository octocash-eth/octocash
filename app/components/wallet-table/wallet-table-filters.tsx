import type { ColumnFiltersState } from "@tanstack/react-table";
import type { LucideIcon } from "lucide-react";
import { Filter } from "lucide-react";
import * as React from "react";

import { Button } from "../ui/button";
import { FilterDropdown } from "./filter-dropdown";

export interface WalletTableFilterConfig<_TData, TOption> {
  id: string;
  label: string;
  icon: LucideIcon;
  emptyMessage: string;
  items: TOption[];
  getValue?: (option: TOption) => string;
  renderOption: (option: TOption) => React.ReactNode;
}

export interface WalletTableFilterDescriptor {
  id: string;
  label: string;
  icon: LucideIcon;
  emptyMessage: string;
  items: unknown[];
  getValue: (item: unknown) => string;
  renderItem: (item: unknown) => React.ReactNode;
  selectedItems: readonly string[];
  onToggle: (value: string, isSelected: boolean) => void;
  onClear: () => void;
}

export interface WalletTableFiltersProps {
  filters: WalletTableFilterDescriptor[];
  hasActiveFilters: boolean;
  onClearAll: () => void;
}

interface UseWalletTableFiltersParams<TData> {
  setColumnFilters: React.Dispatch<React.SetStateAction<ColumnFiltersState>>;
  filterConfigs: ReadonlyArray<WalletTableFilterConfig<TData, unknown>>;
}

export function WalletTableFilters<TData>({ setColumnFilters, filterConfigs }: UseWalletTableFiltersParams<TData>) {
  const [selectedValuesById, setSelectedValuesById] = React.useState<Record<string, string[]>>(() => {
    const initialEntries = filterConfigs.map((config) => [config.id, [] as string[]]);
    return Object.fromEntries(initialEntries);
  });

  React.useEffect(() => {
    setSelectedValuesById((previous) => {
      const next: Record<string, string[]> = {};
      filterConfigs.forEach((config) => {
        next[config.id] = previous[config.id] ?? [];
      });
      return next;
    });
  }, [filterConfigs]);

  React.useEffect(() => {
    const filterIds = filterConfigs.map((config) => config.id);
    setColumnFilters((previous) => {
      const withoutManaged = previous.filter((filter) => !filterIds.includes(filter.id));
      const activeFilters = filterIds.flatMap((id) => {
        const values = selectedValuesById[id] ?? [];
        return values.length > 0 ? [{ id, value: values }] : [];
      });
      return [...withoutManaged, ...activeFilters];
    });
  }, [filterConfigs, selectedValuesById, setColumnFilters]);

  const filters = React.useMemo<WalletTableFilterDescriptor[]>(() => {
    return filterConfigs.map((config) => {
      const selectedItems = selectedValuesById[config.id] ?? [];

      const onToggle = (value: string, isSelected: boolean) => {
        setSelectedValuesById((previous) => {
          const current = previous[config.id] ?? [];

          if (isSelected) {
            if (current.includes(value)) {
              return previous;
            }
            return {
              ...previous,
              [config.id]: [...current, value],
            };
          }

          if (!current.includes(value)) {
            return previous;
          }

          return {
            ...previous,
            [config.id]: current.filter((item) => item !== value),
          };
        });
      };

      const onClear = () => {
        setSelectedValuesById((previous) => {
          if ((previous[config.id] ?? []).length === 0) {
            return previous;
          }

          return {
            ...previous,
            [config.id]: [],
          };
        });
      };

      return {
        id: config.id,
        label: config.label,
        icon: config.icon,
        emptyMessage: config.emptyMessage,
        items: config.items,
        getValue: (option: unknown) => config.getValue?.(option as never) ?? String(option),
        renderItem: (option: unknown) => config.renderOption(option as never),
        selectedItems,
        onToggle,
        onClear,
      } satisfies WalletTableFilterDescriptor;
    });
  }, [filterConfigs, selectedValuesById]);

  const hasActiveFilters = React.useMemo(
    () => Object.values(selectedValuesById).some((values) => values.length > 0),
    [selectedValuesById],
  );

  const onClearAll = React.useCallback(() => {
    setSelectedValuesById((previous) => {
      const hasChanges = filterConfigs.some((config) => (previous[config.id]?.length ?? 0) > 0);
      if (!hasChanges) {
        return previous;
      }

      const next: Record<string, string[]> = {};
      filterConfigs.forEach((config) => {
        next[config.id] = [];
      });
      return next;
    });
  }, [filterConfigs]);

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 flex-1">
        <span className="text-sm font-medium">
          <Filter className="h-4 w-4 inline-block mr-1" />
          Filter by
        </span>

        {filters.map((filter) => (
          <FilterDropdown<unknown>
            key={filter.id}
            icon={filter.icon}
            label={filter.label}
            selectedItems={filter.selectedItems}
            items={filter.items}
            getValue={(item) => filter.getValue(item)}
            renderItem={(item) => filter.renderItem(item)}
            onToggle={filter.onToggle}
            onClear={filter.onClear}
            emptyMessage={filter.emptyMessage}
          />
        ))}

        <Button disabled={!hasActiveFilters} variant="ghost" size="sm" onClick={onClearAll} className="text-xs">
          Clear all
        </Button>
      </div>
    </div>
  );
}
