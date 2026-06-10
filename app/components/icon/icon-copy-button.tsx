import { Check, Copy } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface IconCopyButtonProps extends Omit<React.ComponentProps<typeof Button>, "onCopy"> {
  text: string;
  copyTitle?: string;
  copiedDuration?: number;
  onCopySuccess?: () => void;
}

const IconCopyButton = React.forwardRef<HTMLButtonElement, IconCopyButtonProps>(
  ({ text, copyTitle = "Copy", copiedDuration = 2000, onCopySuccess, onClick, className, children, ...props }, ref) => {
    const [copied, setCopied] = React.useState(false);
    const timeoutRef = React.useRef<NodeJS.Timeout | undefined>(undefined);

    React.useEffect(() => {
      return () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
      };
    }, []);

    const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();

      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        onCopySuccess?.();

        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }

        timeoutRef.current = setTimeout(() => {
          setCopied(false);
        }, copiedDuration);
      } catch (error) {
        console.error("Failed to copy text:", error);
      }

      onClick?.(e);
    };

    return (
      <Button
        ref={ref}
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleClick}
        className={cn("size-5 rounded-sm p-0", className)}
        title={copied ? "Copied!" : copyTitle}
        {...props}
      >
        {children ?? (copied ? <Check className="size-3" /> : <Copy className="size-3" />)}
      </Button>
    );
  },
);

IconCopyButton.displayName = "IconCopyButton";

export type { IconCopyButtonProps };
export { IconCopyButton };
