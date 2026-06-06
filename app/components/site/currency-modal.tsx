import { Check, Search } from "lucide-react";
import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useSelectedCurrency } from "~/context/currency-provider";
import { type Currency, searchCurrencies } from "~/lib/currencies";
import { cn } from "~/lib/utils";

interface CurrencyModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Searchable currency picker. Matches the design mockup: a "Suggested
 * Currencies" group on top, then an alphabetical "Fiat Currencies" group,
 * with a substring-match search input that filters both groups in place.
 */
export function CurrencyModal({ open, onOpenChange }: CurrencyModalProps) {
  const { currency, setCurrency } = useSelectedCurrency();
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const { suggested, fiat, assets } = React.useMemo(() => {
    const matches = searchCurrencies(query);
    return {
      suggested: matches.filter((c) => c.group === "suggested"),
      fiat: matches.filter((c) => c.group === "fiat"),
      assets: matches.filter((c) => c.group === "asset"),
    };
  }, [query]);

  const handlePick = React.useCallback(
    (code: string) => {
      setCurrency(code);
      onOpenChange(false);
    },
    [setCurrency, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
       * Override the default grid layout with flex-column so the header and
       * search input stay pinned to the top while the list below takes the
       * remaining vertical space and scrolls internally. `min-h-0` on the
       * list is required for it to shrink inside its flex parent so the
       * ScrollArea can take over scrolling.
       */}
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Select Currency</DialogTitle>
          <DialogDescription className="sr-only">
            Choose the currency used to display token values across the app.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            placeholder="Search"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
            aria-label="Search currencies"
          />
        </div>

        <ScrollArea className="-mx-2 min-h-0 flex-1">
          <div className="px-2 pb-1">
            {suggested.length === 0 && fiat.length === 0 && assets.length === 0 ? (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">No currencies match "{query}".</p>
            ) : (
              <>
                {suggested.length > 0 && (
                  <CurrencySection
                    title="Suggested Currencies"
                    items={suggested}
                    selected={currency.code}
                    onPick={handlePick}
                  />
                )}
                {fiat.length > 0 && (
                  <CurrencySection title="Fiat Currencies" items={fiat} selected={currency.code} onPick={handlePick} />
                )}
                {assets.length > 0 && (
                  <CurrencySection title="Other Assets" items={assets} selected={currency.code} onPick={handlePick} />
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function CurrencySection({
  title,
  items,
  selected,
  onPick,
  className,
}: {
  title: string;
  items: Currency[];
  selected: string;
  onPick: (code: string) => void;
  className?: string;
}) {
  return (
    <section className={className} aria-label={title}>
      <h3 className="px-1 pt-8 pb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((c) => (
          <li key={c.code}>
            <CurrencyTile currency={c} isSelected={c.code === selected} onClick={() => onPick(c.code)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CurrencyTile({
  currency,
  isSelected,
  onClick,
}: {
  currency: Currency;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      className={cn(
        "group flex w-full items-center gap-2 rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isSelected && "border-border bg-accent/60 text-accent-foreground",
      )}
    >
      <span className="font-mono text-xs font-semibold tracking-wider text-muted-foreground group-hover:text-accent-foreground">
        {currency.code}
      </span>
      <span className="flex-1 truncate text-sm">{currency.name}</span>
      {isSelected && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
    </button>
  );
}
