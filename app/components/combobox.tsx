import { Check, ChevronDown, Plus, X } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "~/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { triggerStyles } from "~/components/ui/select";
import { cn } from "~/lib/utils";

export interface ComboboxOption {
  value: string;
  removable?: boolean;
}

interface ComboboxProps {
  options: ComboboxOption[];
  labelFunction?: (value: string) => React.ReactNode;
  value?: string;
  onValueChange?: (value: string) => void | Promise<void>;
  onOptionsChange?: (options: ComboboxOption[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  isValidOption?: (value: string) => [boolean, string];
  disabled?: boolean;
  size?: "sm" | "default";
}

export function Combobox({
  options: initialOptions,
  labelFunction = (value) => value,
  value,
  onValueChange,
  onOptionsChange,
  placeholder = "Select option...",
  searchPlaceholder = "Search...",
  className,
  isValidOption,
  disabled,
  size = "default",
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [options, setOptions] = React.useState<ComboboxOption[]>(initialOptions);
  const [searchValue, setSearchValue] = React.useState("");
  const isValidOptionFunc = isValidOption ?? (() => [true, ""]);
  const [isValid, invalidMessage] = isValidOptionFunc(searchValue);

  // Update internal options when prop changes
  React.useEffect(() => {
    setOptions(initialOptions);
  }, [initialOptions]);

  const filteredOptions = React.useMemo(() => {
    if (!searchValue) return options;
    return options.filter((option) => option.value.toLowerCase().includes(searchValue.toLowerCase()));
  }, [options, searchValue]);

  const showAddOption = React.useMemo(() => {
    if (!searchValue.trim()) return false;
    const notDuplicate = !options.some((option) => option.value.toLowerCase() === searchValue.toLowerCase());
    return notDuplicate && isValid;
  }, [options, searchValue, isValid]);

  const selectedOption = options.find((option) => option.value === value);

  const handleAddOption = async () => {
    if (!searchValue.trim()) return;

    const inputValue = searchValue.trim();

    // Call onValueChange and wait for any async transformation
    await onValueChange?.(inputValue);

    // Clear search and close - the value update will trigger adding the option
    setSearchValue("");
    setOpen(false);
  };

  // Add custom options when value changes (after transformation)
  React.useEffect(() => {
    if (!value || options.some((opt) => opt.value === value)) return;

    // This is a new value not in options, add it as removable
    const newOption: ComboboxOption = {
      value,
      removable: true,
    };

    const updatedOptions = [...options, newOption];
    setOptions(updatedOptions);
    onOptionsChange?.(updatedOptions);
  }, [value, options, onOptionsChange]);

  const handleRemoveOption = (optionToRemove: ComboboxOption) => {
    const updatedOptions = options.filter((option) => option.value !== optionToRemove.value);
    setOptions(updatedOptions);
    onOptionsChange?.(updatedOptions);

    // If the removed option was selected, clear the selection
    if (value === optionToRemove.value) {
      onValueChange?.("");
    }
  };

  const handleSelect = (selectedValue: string) => {
    // If clicking the already selected option, just close the dropdown
    if (selectedValue !== value) {
      onValueChange?.(selectedValue);
    }
    setOpen(false);
    setSearchValue("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          disabled={disabled}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          data-size={size}
          className={cn(triggerStyles, "w-full", className)}
          data-placeholder={!selectedOption ? "" : undefined}
        >
          {selectedOption ? labelFunction(selectedOption.value) : placeholder}
          <ChevronDown className="size-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="p-0" style={{ width: "var(--radix-popover-trigger-width)" }} align="start">
        <Command shouldFilter={false} defaultValue={value}>
          <CommandInput placeholder={searchPlaceholder} value={searchValue} onValueChange={setSearchValue} />
          <CommandList onWheel={(e) => e.stopPropagation()}>
            <CommandEmpty>No options found.</CommandEmpty>
            <CommandGroup>
              {filteredOptions.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={handleSelect}
                  className="flex items-center justify-between"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Check className={cn("h-4 w-4 shrink-0", value === option.value ? "opacity-100" : "opacity-0")} />
                    {labelFunction(option.value)}
                  </div>
                  {option.removable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-1 hover:bg-transparent text-muted-foreground hover:text-red-500 shrink-0"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        handleRemoveOption(option);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </CommandItem>
              ))}
              {!showAddOption && !isValid && searchValue.trim() && (
                <CommandItem value={`invalid-${searchValue}`} disabled className="text-muted-foreground">
                  {(invalidMessage || '"$0" is invalid').replace(/\$0/g, searchValue)}
                </CommandItem>
              )}
              {showAddOption && (
                <CommandItem value={`add-${searchValue}`} onSelect={handleAddOption}>
                  <Plus className="mr-2 h-4 w-4 shrink-0" />
                  <div className="flex items-center gap-2 min-w-0">{labelFunction(searchValue.trim())}</div>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
