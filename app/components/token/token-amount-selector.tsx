import * as React from "react";
import { formatUnits, parseUnits } from "viem";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Slider } from "~/components/ui/slider";

/**
 * Rounds a decimal string to the specified number of decimal places using bigint arithmetic
 * to avoid floating point errors.
 *
 * Examples:
 * - roundToDecimals("0.9945", 2) -> "0.99" (checks 3rd digit: 4 < 5, rounds down)
 * - roundToDecimals("0.9955", 2) -> "1" (checks 3rd digit: 5 >= 5, rounds up)
 */
function roundToDecimals(value: string, decimals: number): string {
  if (decimals < 0) return value;

  try {
    // parseUnits handles the rounding automatically (round-half-up)
    // In case viem changes behaviour in the future, we will catch it in the tests.
    const parsed = parseUnits(value, decimals);
    return formatUnits(parsed, decimals);
  } catch {
    // If parsing fails (e.g., invalid format), return the original value
    return value;
  }
}

/**
 * Validates if a string is a valid partial or complete decimal number
 */
function isValidPartialDecimal(value: string): boolean {
  if (value === "" || value === "-" || value === ".") return true;
  if (value === "-.") return true;

  // Check for valid decimal format
  return /^-?\d*\.?\d*$/.test(value);
}

/**
 * Gets the maximum number of decimal places from a list of numeric strings
 */
function getMaxDecimals(...args: (string | undefined)[]): number {
  return Math.max(0, ...args.map((v) => v?.split(".")?.[1]?.length ?? 0));
}

/**
 * Clamps a numeric string value between min and max using high-precision comparison
 */
function clampValue(value: string, min?: string, max?: string, decimals?: number): string {
  // Use provided decimals, or infer from the maximum decimal places in the values
  const decimalPrecision = decimals ?? getMaxDecimals(value, min, max);

  try {
    const valueUnits = parseUnits(value, decimalPrecision);

    if (min !== undefined) {
      const minUnits = parseUnits(min, decimalPrecision);
      if (valueUnits < minUnits) {
        return min;
      }
    }

    if (max !== undefined) {
      const maxUnits = parseUnits(max, decimalPrecision);
      if (valueUnits > maxUnits) {
        return max;
      }
    }

    return value;
  } catch {
    // If parsing fails, return "0" as fallback
    return "0";
  }
}

/**
 * Validates and processes the value on blur
 */
function validateAndClamp(value: string, min?: string, max?: string, decimals?: number): string {
  // Handle empty or invalid input
  if (value === "" || value === "-" || value === "." || value === "-.") {
    return "0";
  }

  // Remove leading zeros except for "0" and "0."
  let processed = value.replace(/^(-?)0+(\d)/, "$1$2");

  // Handle ".5" -> "0.5"
  if (processed.startsWith(".")) {
    processed = `0${processed}`;
  }
  if (processed.startsWith("-.")) {
    processed = `-0${processed.slice(1)}`;
  }

  // Round to decimal places if specified (before clamping to avoid precision issues)
  if (decimals !== undefined && decimals >= 0) {
    processed = roundToDecimals(processed, decimals);
  }

  // Clamp to min/max after rounding
  processed = clampValue(processed, min, max, decimals);

  return processed;
}

// Context
interface TokenAmountSelectorContextValue {
  value: string;
  onValueChange: (value: string) => void;
  min?: string;
  max?: string;
  decimals?: number;
}

const TokenAmountSelectorContext = React.createContext<TokenAmountSelectorContextValue | null>(null);

function useTokenAmountSelector() {
  const context = React.useContext(TokenAmountSelectorContext);
  if (!context) {
    throw new Error("TokenAmountSelector components must be used within TokenAmountSelectorRoot");
  }
  return context;
}

// Root Component
interface TokenAmountSelectorRootProps {
  value: string;
  onValueChange: (value: string) => void;
  min?: string;
  max?: string;
  decimals?: number;
  children: React.ReactNode;
  className?: string;
}

function TokenAmountSelectorRoot({
  value,
  onValueChange,
  min,
  max,
  decimals,
  children,
  className,
}: TokenAmountSelectorRootProps) {
  const contextValue = React.useMemo(
    () => ({
      value,
      onValueChange,
      min,
      max,
      decimals,
    }),
    [value, onValueChange, min, max, decimals],
  );

  return (
    <TokenAmountSelectorContext.Provider value={contextValue}>
      <div className={className}>{children}</div>
    </TokenAmountSelectorContext.Provider>
  );
}

// Input Component
interface TokenAmountSelectorInputProps extends Omit<React.ComponentProps<"input">, "type" | "value" | "onChange"> {}

const TokenAmountSelectorInput = React.forwardRef<HTMLInputElement, TokenAmountSelectorInputProps>(
  ({ className, onBlur, ...props }, ref) => {
    const { value, onValueChange, min, max, decimals } = useTokenAmountSelector();

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;

      // Allow partial input during typing
      if (isValidPartialDecimal(newValue)) {
        onValueChange(newValue);
      }
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      const validatedValue = validateAndClamp(value, min, max, decimals);
      onValueChange(validatedValue);

      // Call parent's onBlur if provided
      onBlur?.(e);
    };

    return (
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        className={className}
        {...props}
      />
    );
  },
);

TokenAmountSelectorInput.displayName = "TokenAmountSelectorInput";

// Slider Component
interface TokenAmountSelectorSliderProps
  extends Omit<React.ComponentProps<typeof Slider>, "value" | "onValueChange" | "min" | "max"> {
  step?: number;
}

function TokenAmountSelectorSlider({ step, ...props }: TokenAmountSelectorSliderProps) {
  const { value, onValueChange, min, max, decimals } = useTokenAmountSelector();

  const minNum = min !== undefined ? Number.parseFloat(min) : 0;
  const maxNum = max !== undefined ? Number.parseFloat(max) : 100;
  const currentAmount = Number.parseFloat(value) || 0;

  // Default step based on decimals
  const defaultStep = decimals !== undefined ? 1 / 10 ** Math.min(decimals, 6) : 0.01;
  const effectiveStep = step ?? defaultStep;

  const handleValueChange = (values: number[]) => {
    const sliderValue = values[0];
    // Clamp slider value to exact max to avoid precision issues
    const clampedValue = sliderValue >= maxNum && max !== undefined ? max : sliderValue.toString();
    onValueChange(clampedValue);
  };

  return (
    <Slider
      value={[currentAmount]}
      min={minNum}
      max={maxNum}
      step={effectiveStep}
      onValueChange={handleValueChange}
      {...props}
    />
  );
}

// MaxButton Component
interface TokenAmountSelectorMaxButtonProps extends React.ComponentProps<typeof Button> {}

const TokenAmountSelectorMaxButton = React.forwardRef<HTMLButtonElement, TokenAmountSelectorMaxButtonProps>(
  ({ children, onClick, ...props }, ref) => {
    const { max, onValueChange } = useTokenAmountSelector();

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (max !== undefined) {
        onValueChange(max);
      }
      onClick?.(e);
    };

    return (
      <Button ref={ref} type="button" onClick={handleClick} {...props}>
        {children ?? "Max"}
      </Button>
    );
  },
);

TokenAmountSelectorMaxButton.displayName = "TokenAmountSelectorMaxButton";

export { TokenAmountSelectorInput, TokenAmountSelectorMaxButton, TokenAmountSelectorRoot, TokenAmountSelectorSlider };
