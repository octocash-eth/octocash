import { ChevronDown } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { useSelectedCurrency } from "~/context/currency-provider";
import { CurrencyModal } from "./currency-modal";

interface CurrencySelectorProps {
  /** Render flavour. The mobile menu uses a wider, full-width button. */
  variant?: "compact" | "wide";
}

/**
 * Top-bar toggle that displays the currently-selected fiat currency (e.g.
 * "USD") and opens {@link CurrencyModal} on click. Must be rendered inside a
 * `<CurrencyProvider>`, which `_wallet.tsx` mounts for the wallet-scoped
 * routes (the only place where prices appear in the UI today).
 */
export function CurrencySelector({ variant = "compact" }: CurrencySelectorProps) {
  const { currency } = useSelectedCurrency();
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={variant === "compact" ? "sm" : "default"}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Selected currency: ${currency.code}. Change currency.`}
        className={variant === "wide" ? "w-full justify-between" : undefined}
      >
        <span className="font-mono text-xs font-semibold tracking-wider">{currency.code}</span>
        <ChevronDown aria-hidden="true" className="size-4 opacity-60" />
      </Button>
      <CurrencyModal open={open} onOpenChange={setOpen} />
    </>
  );
}
