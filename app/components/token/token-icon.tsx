import * as React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";

type TokenIconSize = "thumb" | "small" | "large";

/**
 * Map a rendered CSS width (px) to the smallest asset variant that still looks
 * crisp at that size. The proxy serves `thumb` (~25px) by default, with
 * `small` (~50px) and `large` (~250px) available for bigger renders.
 */
function iconSizeForWidth(width: number): TokenIconSize {
  if (width <= 28) return "thumb";
  if (width <= 72) return "small";
  return "large";
}

export function TokenIcon({
  token,
  iconUrl,
  size,
  className,
}: {
  token: string;
  iconUrl?: string;
  /** Force a specific asset variant. When omitted, it is derived from the rendered size. */
  size?: TokenIconSize;
  className?: string;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = React.useState<TokenIconSize>();

  React.useEffect(() => {
    if (size) return; // explicit override wins; no need to measure
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const update = () => setMeasured(iconSizeForWidth(el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [size]);

  const resolved = size ?? measured;
  // `thumb` is what the proxy returns by default, so only append a query for larger variants.
  const src = iconUrl && resolved && resolved !== "thumb" ? `${iconUrl}?size=${resolved}` : iconUrl;

  return (
    <Avatar ref={ref} className={className}>
      <AvatarImage src={src} alt={token} />
      <AvatarFallback className="text-[10px] bg-muted text-muted-foreground">
        {token.charAt(0)?.toUpperCase() || "?"}
      </AvatarFallback>
    </Avatar>
  );
}
