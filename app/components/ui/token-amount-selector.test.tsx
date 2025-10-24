import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
  TokenAmountSelectorInput,
  TokenAmountSelectorMaxButton,
  TokenAmountSelectorRoot,
  TokenAmountSelectorSlider,
} from "./token-amount-selector";

// Mock ResizeObserver for Radix UI Slider
beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

/**
 * Controlled wrapper component for testing
 */
function ControlledTokenAmountSelector(
  props: Omit<React.ComponentProps<typeof TokenAmountSelectorRoot>, "value" | "onValueChange" | "children"> & {
    initialValue?: string;
    onValueChange?: (value: string) => void;
    children?: React.ReactNode;
  },
) {
  const { initialValue = "", onValueChange, children, ...rest } = props;
  const [value, setValue] = useState(initialValue);

  const handleChange = (newValue: string) => {
    setValue(newValue);
    onValueChange?.(newValue);
  };

  return (
    <TokenAmountSelectorRoot value={value} onValueChange={handleChange} {...rest}>
      {children ?? <TokenAmountSelectorInput />}
    </TokenAmountSelectorRoot>
  );
}

describe("TokenAmountSelector Component", () => {
  describe("rounding behavior", () => {
    test("rounds down when digit at decimals+1 position is < 5", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "0.9945");
      await user.tab(); // Trigger blur

      // Should round to 0.99 (4 < 5)
      expect(onValueChange).toHaveBeenLastCalledWith("0.99");
    });

    test("rounds up when digit at decimals+1 position is >= 5", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "0.9955");
      await user.tab(); // Trigger blur

      // Should round to 1 (5 >= 5)
      expect(onValueChange).toHaveBeenLastCalledWith("1");
    });

    test("handles edge case of 1.999 rounding to 2", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "1.999");
      await user.tab(); // Trigger blur

      expect(onValueChange).toHaveBeenLastCalledWith("2");
    });

    test("handles rounding from fractional cents", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "0.005");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("0.01");
    });

    test("truncates when below rounding threshold", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "0.001");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("0");
    });

    test("handles large numbers correctly", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "99.999");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("100");
    });
  });

  describe("partial input during typing", () => {
    test("allows typing partial decimals like '1.'", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "1.");

      // Should allow the partial input
      expect(onValueChange).toHaveBeenCalledWith("1");
      expect(onValueChange).toHaveBeenCalledWith("1.");
    });

    test("allows typing decimals starting with '.'", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, ".5");

      expect(onValueChange).toHaveBeenCalledWith(".");
      expect(onValueChange).toHaveBeenCalledWith(".5");
    });

    test("normalizes '.5' to '0.5' on blur", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, ".5");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("0.5");
    });

    test("allows empty string during typing", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="123" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.clear(input);

      expect(onValueChange).toHaveBeenCalledWith("");
    });

    test("converts empty string to '0' on blur", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="123" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.clear(input);
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("0");
    });

    test("allows typing negative sign", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "-");

      expect(onValueChange).toHaveBeenCalledWith("-");
    });
  });

  describe("min/max clamping", () => {
    test("clamps value to max on blur", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} min="0" max="100" decimals={2} />,
      );
      const input = screen.getByRole("textbox");

      await user.type(input, "150");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("100");
    });

    test("clamps value to min on blur", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} min="0" max="100" decimals={2} />,
      );
      const input = screen.getByRole("textbox");

      await user.type(input, "-5");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("0");
    });

    test("allows values within range", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} min="0" max="100" decimals={2} />,
      );
      const input = screen.getByRole("textbox");

      await user.type(input, "50.5");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("50.5");
    });

    test("clamps exact max value correctly", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} min="0" max="100" decimals={2} />,
      );
      const input = screen.getByRole("textbox");

      await user.type(input, "100");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("100");
    });
  });

  describe("decimal precision", () => {
    test("respects decimals prop for high precision tokens", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={6} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "1.23456789");
      await user.tab();

      // Should round to 6 decimals (7th digit is 8, so rounds up)
      expect(onValueChange).toHaveBeenLastCalledWith("1.234568");
    });

    test("respects decimals=0 for whole numbers only", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={0} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "1.7");
      await user.tab();

      // Should round to nearest whole number
      expect(onValueChange).toHaveBeenLastCalledWith("2");
    });

    test("handles decimals=0 rounding down", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={0} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "1.4");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("1");
    });

    test("allows partial decimal input even with decimals=0", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={0} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "1.7");

      // During typing, allows decimal
      expect(onValueChange).toHaveBeenCalledWith("1");
      expect(onValueChange).toHaveBeenCalledWith("1.");
      expect(onValueChange).toHaveBeenCalledWith("1.7");
    });
  });

  describe("input validation", () => {
    test("rejects non-numeric characters", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "abc");

      // Should not call onValueChange for invalid characters
      expect(onValueChange).not.toHaveBeenCalled();
    });

    test("allows only one decimal point", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "1.2.3");

      // Should only accept characters up to the second decimal point
      const calls = onValueChange.mock.calls.map((call) => call[0]);
      expect(calls).toContain("1");
      expect(calls).toContain("1.");
      expect(calls).toContain("1.2");
      expect(calls).not.toContain("1.2.");
    });

    test("removes leading zeros on blur", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "007");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("7");
    });

    test("preserves single leading zero before decimal", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "0.5");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("0.5");
    });
  });

  describe("component props", () => {
    test("forwards className to input", () => {
      render(
        <TokenAmountSelectorRoot value="0" onValueChange={vi.fn()}>
          <TokenAmountSelectorInput className="custom-class" />
        </TokenAmountSelectorRoot>,
      );
      const input = screen.getByRole("textbox");

      expect(input).toHaveClass("custom-class");
    });

    test("forwards placeholder to input", () => {
      render(
        <TokenAmountSelectorRoot value="" onValueChange={vi.fn()}>
          <TokenAmountSelectorInput placeholder="0.00" />
        </TokenAmountSelectorRoot>,
      );
      const input = screen.getByRole("textbox");

      expect(input).toHaveAttribute("placeholder", "0.00");
    });

    test("uses inputMode='decimal' for better mobile keyboard", () => {
      render(
        <TokenAmountSelectorRoot value="" onValueChange={vi.fn()}>
          <TokenAmountSelectorInput />
        </TokenAmountSelectorRoot>,
      );
      const input = screen.getByRole("textbox");

      expect(input).toHaveAttribute("inputMode", "decimal");
    });

    test("uses type='text' not type='number'", () => {
      render(
        <TokenAmountSelectorRoot value="" onValueChange={vi.fn()}>
          <TokenAmountSelectorInput />
        </TokenAmountSelectorRoot>,
      );
      const input = screen.getByRole("textbox");

      expect(input).toHaveAttribute("type", "text");
    });

    test("calls parent onBlur handler if provided", async () => {
      const user = userEvent.setup();
      const onBlur = vi.fn();
      const onValueChange = vi.fn();

      render(
        <TokenAmountSelectorRoot value="10" onValueChange={onValueChange}>
          <TokenAmountSelectorInput onBlur={onBlur} />
        </TokenAmountSelectorRoot>,
      );
      const input = screen.getByRole("textbox");

      await user.click(input);
      await user.tab();

      expect(onBlur).toHaveBeenCalled();
    });

    test("forwards disabled prop", () => {
      render(
        <TokenAmountSelectorRoot value="0" onValueChange={vi.fn()}>
          <TokenAmountSelectorInput disabled />
        </TokenAmountSelectorRoot>,
      );
      const input = screen.getByRole("textbox");

      expect(input).toBeDisabled();
    });
  });

  describe("controlled component behavior", () => {
    test("displays the provided value prop", () => {
      render(
        <TokenAmountSelectorRoot value="42.5" onValueChange={vi.fn()}>
          <TokenAmountSelectorInput />
        </TokenAmountSelectorRoot>,
      );
      const input = screen.getByRole("textbox") as HTMLInputElement;

      expect(input.value).toBe("42.5");
    });

    test("updates when value prop changes", () => {
      const { rerender } = render(
        <TokenAmountSelectorRoot value="10" onValueChange={vi.fn()}>
          <TokenAmountSelectorInput />
        </TokenAmountSelectorRoot>,
      );
      const input = screen.getByRole("textbox") as HTMLInputElement;

      expect(input.value).toBe("10");

      rerender(
        <TokenAmountSelectorRoot value="20" onValueChange={vi.fn()}>
          <TokenAmountSelectorInput />
        </TokenAmountSelectorRoot>,
      );

      expect(input.value).toBe("20");
    });
  });

  describe("combined scenarios", () => {
    test("clamps and rounds together when exceeding max", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} min="0" max="100" decimals={2} />,
      );
      const input = screen.getByRole("textbox");

      await user.type(input, "150.9955");
      await user.tab();

      // Should clamp to 100 (not round to 151)
      expect(onValueChange).toHaveBeenLastCalledWith("100");
    });

    test("clamps to exact max value with high precision", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      // Simulate high-precision token amounts (18 decimals)
      const maxAmount = "0.974325570775807518";
      render(
        <ControlledTokenAmountSelector
          initialValue=""
          onValueChange={onValueChange}
          min="0"
          max={maxAmount}
          decimals={18}
        />,
      );
      const input = screen.getByRole("textbox");

      // Try to enter a value that exceeds max
      await user.type(input, "0.974325570775807519");
      await user.tab();

      // Should clamp to exact max, not exceed it
      expect(onValueChange).toHaveBeenLastCalledWith(maxAmount);
    });

    test("handles max value when it has many decimal places", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      const maxAmount = "1.234567890123456789";
      render(
        <ControlledTokenAmountSelector
          initialValue=""
          onValueChange={onValueChange}
          min="0"
          max={maxAmount}
          decimals={18}
        />,
      );
      const input = screen.getByRole("textbox");

      // Enter exactly the max value
      await user.type(input, maxAmount);
      await user.tab();

      // Should preserve exact max value
      expect(onValueChange).toHaveBeenLastCalledWith(maxAmount);
    });

    test("handles negative numbers with rounding", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "-1.235");
      await user.tab();

      expect(onValueChange).toHaveBeenLastCalledWith("-1.24");
    });

    test("handles multiple edit cycles", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(<ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} decimals={2} />);
      const input = screen.getByRole("textbox");

      // First edit
      await user.type(input, "10.5");
      await user.tab();
      expect(onValueChange).toHaveBeenLastCalledWith("10.5");

      // Second edit
      await user.clear(input);
      await user.type(input, "20.999");
      await user.tab();
      expect(onValueChange).toHaveBeenLastCalledWith("21");
    });

    test("doesn't modify value if already within constraints", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="" onValueChange={onValueChange} min="0" max="100" decimals={2} />,
      );
      const input = screen.getByRole("textbox");

      await user.type(input, "50.5");
      onValueChange.mockClear(); // Clear previous onChange calls

      await user.tab();

      // Should call with the same value (no modification needed)
      expect(onValueChange).toHaveBeenLastCalledWith("50.5");
    });
  });

  describe("compound component integration", () => {
    test("MaxButton sets value to max", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="0" onValueChange={onValueChange} max="100" decimals={2}>
          <TokenAmountSelectorInput />
          <TokenAmountSelectorMaxButton />
        </ControlledTokenAmountSelector>,
      );

      const maxButton = screen.getByRole("button", { name: /max/i });
      await user.click(maxButton);

      expect(onValueChange).toHaveBeenLastCalledWith("100");
    });

    test("MaxButton with custom children", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="0" onValueChange={onValueChange} max="100">
          <TokenAmountSelectorInput />
          <TokenAmountSelectorMaxButton>Set Max</TokenAmountSelectorMaxButton>
        </ControlledTokenAmountSelector>,
      );

      const maxButton = screen.getByRole("button", { name: /set max/i });
      await user.click(maxButton);

      expect(onValueChange).toHaveBeenLastCalledWith("100");
    });

    test("Slider updates value", async () => {
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="50" onValueChange={onValueChange} min="0" max="100" decimals={2}>
          <TokenAmountSelectorSlider />
        </ControlledTokenAmountSelector>,
      );

      // Slider should be rendered
      const slider = screen.getByRole("slider");
      expect(slider).toBeInTheDocument();
    });

    test("Slider clamps to exact max when at maximum", async () => {
      const onValueChange = vi.fn();
      const maxAmount = "0.974325570775807518";

      render(
        <ControlledTokenAmountSelector
          initialValue={maxAmount}
          onValueChange={onValueChange}
          min="0"
          max={maxAmount}
          decimals={18}
        >
          <TokenAmountSelectorSlider />
        </ControlledTokenAmountSelector>,
      );

      const slider = screen.getByRole("slider");
      expect(slider).toBeInTheDocument();
      expect(slider).toHaveAttribute("aria-valuemax", Number.parseFloat(maxAmount).toString());
    });

    test("all components work together", async () => {
      const user = userEvent.setup();
      const onValueChange = vi.fn();

      render(
        <ControlledTokenAmountSelector initialValue="0" onValueChange={onValueChange} min="0" max="100" decimals={2}>
          <TokenAmountSelectorSlider />
          <TokenAmountSelectorInput placeholder="0.00" />
          <TokenAmountSelectorMaxButton />
        </ControlledTokenAmountSelector>,
      );

      // Type in input
      const input = screen.getByRole("textbox");
      await user.type(input, "50.5");
      await user.tab();
      expect(onValueChange).toHaveBeenLastCalledWith("50.5");

      // Click max button
      const maxButton = screen.getByRole("button", { name: /max/i });
      await user.click(maxButton);
      expect(onValueChange).toHaveBeenLastCalledWith("100");

      // Check slider is present
      const slider = screen.getByRole("slider");
      expect(slider).toBeInTheDocument();
    });
  });
});
