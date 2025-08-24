import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "~/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

export interface ComboboxOption {
  value: string;
  removable?: boolean;
}

interface ComboboxProps {
  options: ComboboxOption[];
  labelFunction?: (value: string) => React.ReactNode;
  value?: string;
  onValueChange?: (value: string) => void;
  onOptionsChange?: (options: ComboboxOption[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  isValidOption?: [(value: string) => boolean, string];
  disabled?: boolean;
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
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [options, setOptions] = React.useState<ComboboxOption[]>(initialOptions);
  const [searchValue, setSearchValue] = React.useState("");
  const [isValidOptionFunc, invalidMessage] = isValidOption ?? [() => true, ""];
  const isInvalid = !isValidOptionFunc(searchValue);

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
    return notDuplicate && !isInvalid;
  }, [options, searchValue, isInvalid]);

  const selectedOption = options.find((option) => option.value === value);

  const handleAddOption = () => {
    if (!searchValue.trim()) return;

    const newOption: ComboboxOption = {
      value: searchValue.trim(),
      removable: true,
    };

    const updatedOptions = [...options, newOption];
    setOptions(updatedOptions);
    onOptionsChange?.(updatedOptions);
    onValueChange?.(newOption.value);
    setSearchValue("");
    setOpen(false);
  };

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
    onValueChange?.(selectedValue === value ? "" : selectedValue);
    setOpen(false);
    setSearchValue("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          disabled={disabled}
          variant="outline"
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn("w-full justify-between", className)}
        >
          {selectedOption ? labelFunction(selectedOption.value) : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={searchPlaceholder} value={searchValue} onValueChange={setSearchValue} />
          <CommandList>
            <CommandEmpty>No options found.</CommandEmpty>
            <CommandGroup>
              {filteredOptions.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={handleSelect}
                  className="flex items-center justify-between"
                >
                  <div className="flex items-center">
                    <Check className={cn("mr-2 h-4 w-4", value === option.value ? "opacity-100" : "opacity-0")} />
                    {labelFunction(option.value)}
                  </div>
                  {option.removable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto p-1 hover:bg-transparent text-muted-foreground hover:text-red-500"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveOption(option);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </CommandItem>
              ))}
              {!showAddOption && isInvalid && searchValue.trim() && (
                <CommandItem value={`invalid-${searchValue}`} disabled className="text-muted-foreground">
                  {(invalidMessage ?? '"$0" is invalid').replace(/\$0/g, searchValue)}
                </CommandItem>
              )}
              {showAddOption && (
                <CommandItem value={`add-${searchValue}`} onSelect={handleAddOption} className="text-muted-foreground">
                  <Plus className="mr-2 h-4 w-4" />
                  Add "{searchValue}" to the list
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
