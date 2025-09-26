import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";

interface FilterDropdownProps<T> {
  icon: LucideIcon;
  label: string;
  selectedItems: readonly string[];
  items: T[];
  getValue?: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  onToggle: (value: string, isSelected: boolean) => void;
  onClear: () => void;
  emptyMessage: string;
}

export function FilterDropdown<T>({
  icon,
  label,
  selectedItems,
  items,
  getValue,
  renderItem,
  onToggle,
  onClear,
  emptyMessage,
}: FilterDropdownProps<T>) {
  const Icon = icon;
  const selectedCount = selectedItems.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="flex gap-2">
          <Icon className="h-4 w-4" />
          {label}
          {selectedCount > 0 && (
            <span className="ml-1 rounded-full bg-primary text-primary-foreground px-2 py-0.5 text-xs">
              {selectedCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {items.length > 0 ? (
          items.map((item) => {
            const value = getValue?.(item) ?? String(item);

            return (
              <DropdownMenuCheckboxItem
                key={value}
                checked={selectedItems.includes(value)}
                onCheckedChange={(checked) => onToggle(value, checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                {renderItem(item)}
              </DropdownMenuCheckboxItem>
            );
          })
        ) : (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">{emptyMessage}</div>
        )}
        <Button
          disabled={selectedCount === 0}
          variant="ghost"
          size="sm"
          className="w-full mt-2 text-xs"
          onClick={() => onClear()}
        >
          Clear
        </Button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
