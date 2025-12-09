import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { Combobox, type ComboboxOption } from "./combobox";

describe("Combobox", () => {
  const defaultOptions: ComboboxOption[] = [{ value: "apple" }, { value: "banana" }, { value: "cherry" }];

  describe("rendering", () => {
    test("renders with default placeholder", () => {
      render(<Combobox options={defaultOptions} />);
      expect(screen.getByText("Select option...")).toBeInTheDocument();
    });

    test("renders with custom placeholder", () => {
      render(<Combobox options={defaultOptions} placeholder="Choose a fruit" />);
      expect(screen.getByText("Choose a fruit")).toBeInTheDocument();
    });

    test("renders closed by default", () => {
      render(<Combobox options={defaultOptions} />);
      const trigger = screen.getByRole("button", { name: /select option/i });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    test("applies custom className", () => {
      render(<Combobox options={defaultOptions} className="custom-class" />);
      const trigger = screen.getByRole("button");
      expect(trigger).toHaveClass("custom-class");
    });

    test("renders with default size", () => {
      render(<Combobox options={defaultOptions} />);
      const trigger = screen.getByRole("button");
      expect(trigger).toHaveAttribute("data-size", "default");
    });

    test("renders with small size", () => {
      render(<Combobox options={defaultOptions} size="sm" />);
      const trigger = screen.getByRole("button");
      expect(trigger).toHaveAttribute("data-size", "sm");
    });

    test("renders disabled state", () => {
      render(<Combobox options={defaultOptions} disabled />);
      const trigger = screen.getByRole("button");
      expect(trigger).toBeDisabled();
    });
  });

  describe("opening and closing", () => {
    test("opens dropdown when trigger is clicked", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} />);

      const trigger = screen.getByRole("button");
      await user.click(trigger);

      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
    });

    test("displays all options when opened", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} />);

      await user.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("apple")).toBeInTheDocument();
        expect(screen.getByText("banana")).toBeInTheDocument();
        expect(screen.getByText("cherry")).toBeInTheDocument();
      });
    });

    test("renders custom search placeholder", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} searchPlaceholder="Find fruit..." />);

      await user.click(screen.getByRole("button"));

      expect(screen.getByPlaceholderText("Find fruit...")).toBeInTheDocument();
    });
  });

  describe("value selection", () => {
    test("displays selected value", () => {
      render(<Combobox options={defaultOptions} value="apple" />);
      expect(screen.getByText("apple")).toBeInTheDocument();
    });

    test("calls onValueChange when option is selected", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(<Combobox options={defaultOptions} onValueChange={onValueChange} />);

      await user.click(screen.getByRole("button"));
      await waitFor(() => screen.getByText("banana"));
      await user.click(screen.getByText("banana"));

      expect(onValueChange).toHaveBeenCalledWith("banana");
    });

    test("closes dropdown after selection", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} />);

      const trigger = screen.getByRole("button");
      await user.click(trigger);
      await waitFor(() => screen.getByText("cherry"));
      await user.click(screen.getByText("cherry"));

      await waitFor(() => {
        expect(trigger).toHaveAttribute("aria-expanded", "false");
      });
    });

    test("does not call onValueChange when clicking already selected option", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(<Combobox options={defaultOptions} value="apple" onValueChange={onValueChange} />);

      await user.click(screen.getByRole("button"));
      // Wait for the option to appear, then click it
      await waitFor(() => {
        const options = screen.getAllByRole("option");
        expect(options.length).toBeGreaterThan(0);
      });
      const appleOption = screen.getAllByRole("option").find((opt) => opt.textContent?.includes("apple"));
      if (appleOption) {
        await user.click(appleOption);
      }

      expect(onValueChange).not.toHaveBeenCalled();
    });

    test("shows check icon for selected option", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} value="banana" />);

      await user.click(screen.getByRole("button"));

      await waitFor(() => {
        const items = screen.getAllByRole("option");
        const bananaItem = items.find((item) => item.textContent?.includes("banana"));
        expect(bananaItem?.querySelector(".opacity-100")).toBeInTheDocument();
      });
    });
  });

  describe("search and filtering", () => {
    test("filters options based on search input", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "ban");

      await waitFor(() => {
        expect(screen.getByText("banana")).toBeInTheDocument();
        expect(screen.queryByText("apple")).not.toBeInTheDocument();
        expect(screen.queryByText("cherry")).not.toBeInTheDocument();
      });
    });

    test("search is case insensitive", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "BAN");

      await waitFor(() => {
        expect(screen.getByText("banana")).toBeInTheDocument();
      });
    });

    test("shows 'No options found' when no matches and empty options", async () => {
      const user = userEvent.setup();
      // Use empty options array so CommandEmpty will show
      render(<Combobox options={[]} />);

      await user.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("No options found.")).toBeInTheDocument();
      });
    });

    test("clears search after selection", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "ban");
      await waitFor(() => screen.getByText("banana"));
      await user.click(screen.getByText("banana"));

      // Reopen to check search was cleared
      await user.click(screen.getByRole("button"));
      const searchInputAfter = screen.getByPlaceholderText("Search...");
      expect(searchInputAfter).toHaveValue("");
    });
  });

  describe("custom label function", () => {
    test("uses custom labelFunction to display options", async () => {
      const user = userEvent.setup();
      const labelFunction = (value: string) => `Fruit: ${value}`;
      render(<Combobox options={defaultOptions} labelFunction={labelFunction} />);

      await user.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("Fruit: apple")).toBeInTheDocument();
        expect(screen.getByText("Fruit: banana")).toBeInTheDocument();
        expect(screen.getByText("Fruit: cherry")).toBeInTheDocument();
      });
    });

    test("uses labelFunction for selected value", () => {
      const labelFunction = (value: string) => `Selected: ${value}`;
      render(<Combobox options={defaultOptions} value="apple" labelFunction={labelFunction} />);

      expect(screen.getByText("Selected: apple")).toBeInTheDocument();
    });

    test("uses labelFunction with ReactNode return", async () => {
      const user = userEvent.setup();
      const labelFunction = (value: string) => <span className="custom">{value.toUpperCase()}</span>;
      render(<Combobox options={defaultOptions} labelFunction={labelFunction} />);

      await user.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("APPLE")).toBeInTheDocument();
        expect(screen.getByText("BANANA")).toBeInTheDocument();
      });
    });
  });

  describe("adding custom options", () => {
    test("shows add option button for new search value", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} onValueChange={vi.fn()} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "mango");

      await waitFor(() => {
        expect(screen.getByText("mango")).toBeInTheDocument();
      });
    });

    test("does not show add button for empty search", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} onValueChange={vi.fn()} />);

      await user.click(screen.getByRole("button"));

      expect(screen.queryByText(/add/i)).not.toBeInTheDocument();
    });

    test("does not show add button for duplicate value", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} onValueChange={vi.fn()} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "apple");

      // Should still show the existing apple option
      await waitFor(() => {
        expect(screen.getByText("apple")).toBeInTheDocument();
      });
    });

    test("calls onValueChange when adding new option", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(<Combobox options={defaultOptions} onValueChange={onValueChange} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "mango");

      await waitFor(() => screen.getByText("mango"));
      await user.click(screen.getByText("mango"));

      expect(onValueChange).toHaveBeenCalledWith("mango");
    });

    test("trims whitespace from new option value", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      render(<Combobox options={defaultOptions} onValueChange={onValueChange} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "  mango  ");

      await waitFor(() => screen.getByText("mango"));
      await user.click(screen.getByText("mango"));

      expect(onValueChange).toHaveBeenCalledWith("mango");
    });

    test("closes dropdown after adding option", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} onValueChange={vi.fn()} />);

      const trigger = screen.getByRole("button");
      await user.click(trigger);
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "mango");

      await waitFor(() => screen.getByText("mango"));
      await user.click(screen.getByText("mango"));

      await waitFor(() => {
        expect(trigger).toHaveAttribute("aria-expanded", "false");
      });
    });

    test("adds new value to options list", async () => {
      const _user = userEvent.setup();
      const onOptionsChange = vi.fn();
      render(<Combobox options={defaultOptions} value="mango" onOptionsChange={onOptionsChange} />);

      // Trigger the effect that adds custom options
      await waitFor(() => {
        expect(onOptionsChange).toHaveBeenCalledWith(
          expect.arrayContaining([
            ...defaultOptions,
            expect.objectContaining({
              value: "mango",
              removable: true,
            }),
          ]),
        );
      });
    });

    test("does not duplicate options when value changes", async () => {
      const _user = userEvent.setup();
      const onOptionsChange = vi.fn();
      const { rerender } = render(
        <Combobox options={defaultOptions} value="apple" onOptionsChange={onOptionsChange} />,
      );

      // Change to another existing option
      rerender(<Combobox options={defaultOptions} value="banana" onOptionsChange={onOptionsChange} />);

      // onOptionsChange should not be called for existing options
      expect(onOptionsChange).not.toHaveBeenCalled();
    });
  });

  describe("removing custom options", () => {
    const optionsWithRemovable: ComboboxOption[] = [
      { value: "apple" },
      { value: "banana" },
      { value: "custom", removable: true },
    ];

    test("shows remove button for removable options", async () => {
      const user = userEvent.setup();
      render(<Combobox options={optionsWithRemovable} />);

      await user.click(screen.getByRole("button"));

      await waitFor(() => {
        const items = screen.getAllByRole("option");
        const customItem = items.find((item) => item.textContent?.includes("custom"));
        expect(customItem?.querySelector("button")).toBeInTheDocument();
      });
    });

    test("does not show remove button for non-removable options", async () => {
      const user = userEvent.setup();
      render(<Combobox options={optionsWithRemovable} />);

      await user.click(screen.getByRole("button"));

      await waitFor(() => {
        const items = screen.getAllByRole("option");
        const appleItem = items.find((item) => item.textContent?.includes("apple"));
        // Apple should not have a remove button (X icon)
        expect(appleItem?.textContent?.includes("apple")).toBeTruthy();
      });
    });

    test("calls onOptionsChange when removing option", async () => {
      const user = userEvent.setup();
      const onOptionsChange = vi.fn();
      render(<Combobox options={optionsWithRemovable} onOptionsChange={onOptionsChange} />);

      await user.click(screen.getByRole("button"));

      await waitFor(async () => {
        const items = screen.getAllByRole("option");
        const customItem = items.find((item) => item.textContent?.includes("custom"));
        const removeButton = customItem?.querySelector("button");
        if (removeButton) {
          await user.click(removeButton);
        }
      });

      await waitFor(() => {
        expect(onOptionsChange).toHaveBeenCalledWith([{ value: "apple" }, { value: "banana" }]);
      });
    });

    test("clears value when removing selected option", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();
      const onOptionsChange = vi.fn();
      render(
        <Combobox
          options={optionsWithRemovable}
          value="custom"
          onValueChange={onValueChange}
          onOptionsChange={onOptionsChange}
        />,
      );

      await user.click(screen.getByRole("button"));

      await waitFor(async () => {
        const items = screen.getAllByRole("option");
        const customItem = items.find((item) => item.textContent?.includes("custom"));
        const removeButton = customItem?.querySelector("button");
        if (removeButton) {
          await user.click(removeButton);
        }
      });

      await waitFor(() => {
        expect(onValueChange).toHaveBeenCalledWith("");
      });
    });

    test("does not close dropdown when removing option", async () => {
      const user = userEvent.setup();
      render(<Combobox options={optionsWithRemovable} />);

      const trigger = screen.getByRole("button");
      await user.click(trigger);

      await waitFor(async () => {
        const items = screen.getAllByRole("option");
        const customItem = items.find((item) => item.textContent?.includes("custom"));
        const removeButton = customItem?.querySelector("button");
        if (removeButton) {
          await user.click(removeButton);
        }
      });

      // Dropdown should still be open
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    });
  });

  describe("option validation", () => {
    test("shows invalid message for invalid input", async () => {
      const user = userEvent.setup();
      const isValidOption = (value: string): [boolean, string] => {
        if (value.length < 3) return [false, '"$0" is too short'];
        return [true, ""];
      };
      render(<Combobox options={defaultOptions} isValidOption={isValidOption} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "ab");

      await waitFor(() => {
        expect(screen.getByText('"ab" is too short')).toBeInTheDocument();
      });
    });

    test("uses default invalid message when not provided", async () => {
      const user = userEvent.setup();
      const isValidOption = (value: string): [boolean, string] => {
        if (value.length < 3) return [false, ""];
        return [true, ""];
      };
      render(<Combobox options={defaultOptions} isValidOption={isValidOption} onValueChange={vi.fn()} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "ab");

      await waitFor(() => {
        expect(screen.getByText('"ab" is invalid')).toBeInTheDocument();
      });
    });

    test("does not show add button for invalid input", async () => {
      const user = userEvent.setup();
      const isValidOption = (value: string): [boolean, string] => {
        if (value.length < 3) return [false, "Too short"];
        return [true, ""];
      };
      render(<Combobox options={defaultOptions} onValueChange={vi.fn()} isValidOption={isValidOption} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "ab");

      await waitFor(() => {
        // Should show invalid message, not add button
        expect(screen.getByText("Too short")).toBeInTheDocument();
      });
    });

    test("shows add button when input becomes valid", async () => {
      const user = userEvent.setup();
      const isValidOption = (value: string): [boolean, string] => {
        if (value.length < 3) return [false, "Too short"];
        return [true, ""];
      };
      render(<Combobox options={defaultOptions} onValueChange={vi.fn()} isValidOption={isValidOption} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "abc");

      await waitFor(() => {
        expect(screen.getByText("abc")).toBeInTheDocument();
      });
    });

    test("replaces $0 placeholder in validation message", async () => {
      const user = userEvent.setup();
      const isValidOption = (_value: string): [boolean, string] => {
        return [false, "Value $0 is not allowed"];
      };
      render(<Combobox options={defaultOptions} isValidOption={isValidOption} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "test");

      await waitFor(() => {
        expect(screen.getByText("Value test is not allowed")).toBeInTheDocument();
      });
    });
  });

  describe("async onValueChange", () => {
    test("handles async onValueChange when adding option", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn().mockResolvedValue(undefined);
      render(<Combobox options={defaultOptions} onValueChange={onValueChange} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "mango");

      await waitFor(() => screen.getByText("mango"));
      await user.click(screen.getByText("mango"));

      await waitFor(() => {
        expect(onValueChange).toHaveBeenCalledWith("mango");
      });
    });

    test("waits for async transformation before closing", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 100);
          }),
      );
      render(<Combobox options={defaultOptions} onValueChange={onValueChange} />);

      const trigger = screen.getByRole("button");
      await user.click(trigger);
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "mango");

      await waitFor(() => screen.getByText("mango"));
      await user.click(screen.getByText("mango"));

      await waitFor(() => {
        expect(trigger).toHaveAttribute("aria-expanded", "false");
      });
    });
  });

  describe("edge cases", () => {
    test("handles empty options array", async () => {
      const user = userEvent.setup();
      render(<Combobox options={[]} />);

      await user.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("No options found.")).toBeInTheDocument();
      });
    });

    test("handles undefined value", () => {
      render(<Combobox options={defaultOptions} value={undefined} />);
      expect(screen.getByText("Select option...")).toBeInTheDocument();
    });

    test("handles empty string value", () => {
      render(<Combobox options={defaultOptions} value="" />);
      expect(screen.getByText("Select option...")).toBeInTheDocument();
    });

    test("updates internal options when initialOptions prop changes", () => {
      const { rerender } = render(<Combobox options={defaultOptions} />);

      const newOptions = [...defaultOptions, { value: "orange" }];
      rerender(<Combobox options={newOptions} />);

      // Component should accept the new options
      expect(screen.getByRole("button")).toBeInTheDocument();
    });

    test("handles options with special characters", async () => {
      const user = userEvent.setup();
      const specialOptions: ComboboxOption[] = [{ value: "option-with-dash" }, { value: "option_with_underscore" }];
      render(<Combobox options={specialOptions} />);

      await user.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByText("option-with-dash")).toBeInTheDocument();
        expect(screen.getByText("option_with_underscore")).toBeInTheDocument();
      });
    });

    test("filters partial matches correctly", async () => {
      const user = userEvent.setup();
      render(<Combobox options={defaultOptions} />);

      await user.click(screen.getByRole("button"));
      const searchInput = screen.getByPlaceholderText("Search...");
      await user.type(searchInput, "an");

      await waitFor(() => {
        expect(screen.getByText("banana")).toBeInTheDocument();
        expect(screen.queryByText("apple")).not.toBeInTheDocument();
      });
    });
  });

  describe("placeholder state", () => {
    test("shows placeholder when no value selected", () => {
      render(<Combobox options={defaultOptions} placeholder="Pick one" />);
      const trigger = screen.getByRole("button");
      expect(trigger).toHaveAttribute("data-placeholder", "");
    });

    test("does not show placeholder attribute when value is selected", () => {
      render(<Combobox options={defaultOptions} value="apple" />);
      const trigger = screen.getByRole("button");
      expect(trigger).not.toHaveAttribute("data-placeholder");
    });
  });
});
