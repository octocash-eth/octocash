import * as React from "react";
import { cn } from "~/lib/utils";

interface AnimateHeightProps extends React.ComponentProps<"div"> {
  /** Transition duration in milliseconds. */
  duration?: number;
}

/**
 * Animates its own height to fit the natural height of its children whenever
 * that content changes. The initial mount is rendered at the measured height
 * (before paint) so there is no opening flash.
 *
 * Overflow is only hidden while a height transition is running; at rest the
 * content overflows visibly so popovers, dropdowns and focus rings are not
 * clipped.
 */
export function AnimateHeight({ children, className, duration = 300, style, ...props }: AnimateHeightProps) {
  const innerRef = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState<number>();
  const [animating, setAnimating] = React.useState(false);
  // Only the grow direction clips the bottom of the (already full-size) content,
  // so we only need the softening fade mask while growing.
  const [growing, setGrowing] = React.useState(false);

  React.useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    const update = () => {
      setHeight((prev) => {
        const next = el.offsetHeight;
        if (prev !== undefined && prev !== next) {
          setAnimating(true);
          setGrowing(next > prev);
        }
        return next;
      });
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // While growing, fade the clipped bottom edge instead of hard-cutting it so
  // the new content reveals gently rather than getting chopped.
  const fadeMask = "linear-gradient(to bottom, black calc(100% - 40px), transparent)";
  const maskActive = animating && growing;

  return (
    <div
      className={cn(animating ? "overflow-hidden" : "overflow-visible", className)}
      style={{
        height: height ?? "auto",
        transition: `height ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
        ...(maskActive ? { maskImage: fadeMask, WebkitMaskImage: fadeMask } : {}),
        ...style,
      }}
      onTransitionEnd={(event) => {
        if (event.propertyName === "height") setAnimating(false);
      }}
      {...props}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
