import type { LucideIcon } from "lucide-react";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";

export interface FilterOption {
  /** Filter value written to the column filter when this option is checked. */
  value: string;
  label: ReactNode;
}

interface FilterDropdownProps {
  icon: LucideIcon;
  label: string;
  selectedValues: readonly string[];
  options: readonly FilterOption[];
  onToggle: (value: string, isSelected: boolean) => void;
  onClear: () => void;
  emptyMessage: string;
}

export function FilterDropdown({
  icon,
  label,
  selectedValues,
  options,
  onToggle,
  onClear,
  emptyMessage,
}: FilterDropdownProps) {
  const Icon = icon;
  const selectedCount = selectedValues.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="flex gap-2">
          <Icon className="h-4 w-4 text-pink-500" />
          {label}
          {selectedCount > 0 ? (
            <span className="ml-1 rounded-full bg-primary text-primary-foreground px-2 py-0.5 text-xs">
              {selectedCount}
            </span>
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {options.length > 0 ? (
          options.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={selectedValues.includes(option.value)}
              onCheckedChange={(checked) => onToggle(option.value, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          ))
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
