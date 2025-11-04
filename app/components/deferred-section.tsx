import type { ReactNode } from "react";

interface DeferredSectionProps {
  children: ReactNode;
}

/**
 * DeferredSection uses CSS content-visibility to defer rendering of off-screen content.
 * Content is still in the DOM (good for SEO) but browser skips rendering work until needed.
 * This significantly improves initial page load performance.
 *
 * Browser support: Chrome 85+, Edge 85+, Opera 71+
 * Fallback: Gracefully degrades - content still renders, just not optimized
 */
export function DeferredSection({ children }: DeferredSectionProps) {
  return (
    <div
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: "auto 500px",
      }}
    >
      {children}
    </div>
  );
}
