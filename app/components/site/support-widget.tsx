import {
  CameraIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  CircleAlertIcon,
  LightbulbIcon,
  Loader2Icon,
  MessageSquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

const API_URL = "https://octosupport.blossom.deno.net";

type Category = "issue" | "idea" | "other";
type View = "picker" | "form" | "success" | "error";

const CATEGORY_COPY: Record<
  Category,
  {
    title: string;
    placeholder: string;
    pickerLabel: string;
    Icon: React.ComponentType<{ className?: string }>;
    iconClassName: string;
  }
> = {
  issue: {
    title: "Report an issue",
    placeholder: "I noticed that...",
    pickerLabel: "Report an issue",
    Icon: TriangleAlertIcon,
    iconClassName: "text-amber-500",
  },
  idea: {
    title: "Send an idea",
    placeholder: "What if...",
    pickerLabel: "Share an idea",
    Icon: LightbulbIcon,
    iconClassName: "text-yellow-500",
  },
  other: {
    title: "Send feedback",
    placeholder: "I'd like to share...",
    pickerLabel: "Something else",
    Icon: MessageSquareIcon,
    iconClassName: "text-violet-500 dark:text-violet-300",
  },
};

const CATEGORIES: Category[] = ["issue", "idea", "other"];

export function SupportWidget() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("picker");
  const [category, setCategory] = useState<Category | null>(null);
  const [email, setEmail] = useState("");
  const [text, setText] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotScrollRatio, setScreenshotScrollRatio] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const thumbnailScrollRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const panelId = useId();

  // Render via portal to <body> so the widget escapes any ancestor stacking
  // context (e.g. ThemeProvider, route layouts) and our z-index can actually
  // beat the Radix Dialog overlay (z-50).
  useEffect(() => {
    setMounted(true);
  }, []);

  // With portal-to-body, React's event delegation on the root container may
  // miss events from the portal'd subtree, so attach a native pointerdown
  // listener directly. This prevents an open Radix Dialog's DismissableLayer
  // (which listens for pointerdown on document) from dismissing when the user
  // interacts with the floating widget.
  useEffect(() => {
    if (!mounted) return;
    const el = wrapperRef.current;
    if (!el) return;
    const stop = (event: PointerEvent) => event.stopPropagation();
    el.addEventListener("pointerdown", stop);
    return () => el.removeEventListener("pointerdown", stop);
  }, [mounted]);

  // When a modal Radix Dialog is open underneath the widget, its FocusScope
  // adds document-level focusin/focusout listeners that trap focus: focusing
  // one of our fields makes it immediately yank focus back into the dialog, so
  // the inputs look clickable but can't be typed into. The wrapper-level
  // stopPropagation above can't help because the damaging focusout originates
  // from inside the dialog and never bubbles through our subtree. Intercept
  // focus events in the capture phase (which runs before the dialog's
  // bubble-phase document listener) and stop them whenever the widget is the
  // element gaining or losing focus, leaving the native focus change intact.
  useEffect(() => {
    if (!mounted) return;
    const isInWidget = (node: EventTarget | null) => node instanceof Node && wrapperRef.current?.contains(node);
    const guard = (event: FocusEvent) => {
      if (isInWidget(event.target) || isInWidget(event.relatedTarget)) {
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("focusin", guard, true);
    document.addEventListener("focusout", guard, true);
    return () => {
      document.removeEventListener("focusin", guard, true);
      document.removeEventListener("focusout", guard, true);
    };
  }, [mounted]);

  const resetState = useCallback(() => {
    setView("picker");
    setCategory(null);
    setEmail("");
    setText("");
    setScreenshot(null);
    setScreenshotScrollRatio(0);
    setErrorMessage(null);
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
    resetState();
  }, [resetState]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closePanel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closePanel]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      // Don't dismiss when clicking the trigger itself — it toggles via onClick.
      const trigger = document.querySelector("[data-support-trigger]");
      if (trigger?.contains(target)) return;
      closePanel();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, closePanel]);

  useEffect(() => {
    if (open && view === "form") {
      textareaRef.current?.focus();
    }
  }, [open, view]);

  const onPickCategory = (next: Category) => {
    setCategory(next);
    setView("form");
  };

  const onBackToPicker = () => {
    setView("picker");
    setText("");
    setScreenshot(null);
    setScreenshotScrollRatio(0);
    setErrorMessage(null);
  };

  const onCaptureScreenshot = async () => {
    if (capturing) return;
    setCapturing(true);
    setErrorMessage(null);
    try {
      const { default: html2canvas } = await import("html2canvas-pro");

      // Capture the entire scrollable document so the screenshot includes
      // content above and below the current viewport. We size the canvas to
      // the full document so html2canvas paints the whole page rather than
      // clipping to the visible region.
      const doc = document.documentElement;
      const body = document.body;
      const fullWidth = Math.max(doc.scrollWidth, body.scrollWidth, doc.clientWidth);
      const fullHeight = Math.max(doc.scrollHeight, body.scrollHeight, doc.clientHeight);

      // Remember where the user was scrolled so we can mirror that position
      // inside the thumbnail preview below.
      const maxPageScroll = Math.max(fullHeight - doc.clientHeight, 1);
      const ratio = Math.min(Math.max(window.scrollY / maxPageScroll, 0), 1);

      const fullCanvas = await html2canvas(document.body, {
        useCORS: true,
        logging: false,
        backgroundColor: null,
        width: fullWidth,
        height: fullHeight,
        windowWidth: fullWidth,
        windowHeight: fullHeight,
        scrollX: 0,
        scrollY: 0,
        // Skip the widget's subtree so neither the trigger nor the open panel appear in the snapshot.
        ignoreElements: (el) => el.hasAttribute("data-support-widget"),
      });

      setScreenshotScrollRatio(ratio);
      setScreenshot(fullCanvas.toDataURL("image/jpeg", 0.7));
    } catch (error) {
      console.error("Failed to capture screenshot", error);
      setErrorMessage(error instanceof Error ? `Screenshot failed: ${error.message}` : "Screenshot failed.");
    } finally {
      setCapturing(false);
    }
  };

  const onRemoveScreenshot = () => {
    setScreenshot(null);
    setScreenshotScrollRatio(0);
  };

  // Mirror the page scroll position inside the thumbnail preview. Runs once
  // the image has laid out (on load) and whenever the ratio changes — e.g.
  // after a recapture from a different scroll position.
  const syncThumbnailScroll = useCallback(() => {
    const el = thumbnailScrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = max * screenshotScrollRatio;
  }, [screenshotScrollRatio]);

  // Re-run the sync whenever the captured ratio changes so recaptures from a
  // different page scroll position update the thumbnail without waiting for
  // the (possibly cached) image's onLoad to refire.
  useEffect(() => {
    if (!screenshot) return;
    syncThumbnailScroll();
  }, [screenshot, syncThumbnailScroll]);

  const canSubmit = Boolean(category) && text.trim().length > 0 && !sending;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !category) return;
    setSending(true);
    setErrorMessage(null);
    try {
      const categoryLabel = CATEGORY_COPY[category].title;
      const message = `[${categoryLabel}]\n\n${text.trim()}`;
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "",
          email: email.trim(),
          message,
          screenshot: screenshot ?? undefined,
        }),
      });
      if (!res.ok) {
        setErrorMessage(`Server responded with ${res.status}`);
        setView("error");
        return;
      }
      setView("success");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Network error");
      setView("error");
    } finally {
      setSending(false);
    }
  };

  const showBack = view === "form";
  const headerTitle =
    view === "picker"
      ? "How can we help?"
      : view === "form" && category
        ? CATEGORY_COPY[category].title
        : view === "success"
          ? "Thanks!"
          : "Something went wrong";

  if (!mounted) return null;

  return createPortal(
    <div ref={wrapperRef} data-support-widget>
      <Button
        type="button"
        size="lg"
        data-support-trigger
        className="pointer-events-auto fixed bottom-4 right-4 z-[100] shadow-lg max-md:size-12 max-md:rounded-full max-md:p-0"
        onClick={() => {
          setOpen((prev) => {
            if (prev) resetState();
            return !prev;
          });
        }}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <MessageSquareIcon />
        <span className="hidden md:inline">Get Support</span>
      </Button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          id={panelId}
          className="pointer-events-auto fixed bottom-20 right-4 z-[101] w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {showBack ? (
                <button
                  type="button"
                  onClick={onBackToPicker}
                  aria-label="Back"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronLeftIcon className="size-4" />
                </button>
              ) : (
                <span className="size-7 shrink-0" aria-hidden />
              )}
              <h2 id={headingId} className="truncate text-center text-sm font-semibold flex-1">
                {headerTitle}
              </h2>
            </div>
            <button
              type="button"
              onClick={closePanel}
              aria-label="Close support"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          </div>

          {view === "picker" && (
            <div className="flex flex-col gap-2 p-3">
              {CATEGORIES.map((c) => {
                const copy = CATEGORY_COPY[c];
                const Icon = copy.Icon;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onPickCategory(c)}
                    className="group flex w-full items-center gap-3 rounded-xl border border-border/70 bg-background px-3 py-2.5 text-left transition-colors hover:border-pink-400/50 hover:bg-pink-500/[0.04]"
                  >
                    <span className="inline-flex size-8 items-center justify-center rounded-lg bg-muted/60">
                      <Icon className={cn("size-4", copy.iconClassName)} />
                    </span>
                    <span className="text-sm font-medium">{copy.pickerLabel}</span>
                  </button>
                );
              })}
            </div>
          )}

          {view === "form" && category && (
            <form onSubmit={onSubmit} className="flex flex-col gap-3 p-3">
              <Input
                type="email"
                placeholder="your@email.com (optional)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="h-9"
              />
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={CATEGORY_COPY[category].placeholder}
                rows={4}
                required
                className={cn(
                  "placeholder:text-muted-foreground border-input dark:bg-input/30 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow]",
                  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                )}
              />
              {screenshot && (
                <div className="relative rounded-lg border border-input bg-muted/40 p-1.5">
                  <div ref={thumbnailScrollRef} className="max-h-40 overflow-y-auto rounded-md">
                    <img
                      src={screenshot}
                      alt="Captured screenshot preview"
                      onLoad={syncThumbnailScroll}
                      className="block w-full rounded-md object-contain"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={onRemoveScreenshot}
                    disabled={sending}
                    aria-label="Remove screenshot"
                    title="Remove screenshot"
                    className="absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={onCaptureScreenshot}
                  disabled={capturing || sending}
                  aria-label={screenshot ? "Recapture screenshot" : "Capture screenshot"}
                  title={screenshot ? "Recapture screenshot" : "Capture screenshot"}
                >
                  {capturing ? <Loader2Icon className="animate-spin" /> : <CameraIcon />}
                </Button>
                <Button type="submit" className="flex-1" isLoading={sending} disabled={!canSubmit}>
                  Send feedback
                </Button>
              </div>
              {errorMessage && (
                <p className="text-xs text-destructive" role="alert">
                  {errorMessage}
                </p>
              )}
            </form>
          )}

          {view === "success" && (
            <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
              <CheckCircle2Icon className="size-10 text-emerald-500" />
              <p className="text-sm text-muted-foreground">Thanks for the feedback. We read every message.</p>
              <Button type="button" onClick={closePanel} className="w-full">
                Done
              </Button>
            </div>
          )}

          {view === "error" && (
            <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
              <CircleAlertIcon className="size-10 text-destructive" />
              <p className="text-sm text-muted-foreground">{errorMessage ?? "We couldn't send your feedback."}</p>
              <Button
                type="button"
                onClick={() => {
                  setView("form");
                  setErrorMessage(null);
                }}
                className="w-full"
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
