import type * as React from "react";
import { formatUnits, parseUnits } from "viem";
import { Input } from "~/components/ui/input";

interface InputDecimalProps extends Omit<React.ComponentProps<"input">, "type" | "value" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  min?: number | string;
  max?: number | string;
  decimals?: number;
}

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
 * Clamps a numeric string value between min and max
 */
function clampValue(value: string, min?: string, max?: string): string {
  // Parse as strings to compare
  const numValue = Number.parseFloat(value);

  if (Number.isNaN(numValue)) return "0";

  let clamped = numValue;

  if (min !== undefined) {
    const minValue = Number.parseFloat(min.toString());
    if (!Number.isNaN(minValue) && clamped < minValue) {
      clamped = minValue;
    }
  }

  if (max !== undefined) {
    const maxValue = Number.parseFloat(max.toString());
    if (!Number.isNaN(maxValue) && clamped > maxValue) {
      clamped = maxValue;
    }
  }

  return clamped.toString();
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

  // Clamp to min/max
  processed = clampValue(processed, min, max);

  // Round to decimal places if specified
  if (decimals !== undefined && decimals >= 0) {
    processed = roundToDecimals(processed, decimals);
  }

  return processed;
}

export function InputDecimal({
  value,
  onValueChange,
  min,
  max,
  decimals,
  className,
  onBlur,
  ...props
}: InputDecimalProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;

    // Allow partial input during typing
    if (isValidPartialDecimal(newValue)) {
      onValueChange(newValue);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const validatedValue = validateAndClamp(value, min?.toString(), max?.toString(), decimals);
    onValueChange(validatedValue);

    // Call parent's onBlur if provided
    onBlur?.(e);
  };

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={value}
      onChange={handleChange}
      onBlur={handleBlur}
      className={className}
      {...props}
    />
  );
}
