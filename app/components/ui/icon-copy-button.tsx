import { Check, Copy } from "lucide-react";
import * as React from "react";
import { cn } from "~/lib/utils";
import { Button } from "./button";

interface IconCopyButtonProps extends Omit<React.ComponentProps<typeof Button>, "onCopy"> {
  copied: boolean;
  onCopy: () => void;
  copyTitle?: string;
}

const IconCopyButton = React.forwardRef<HTMLButtonElement, IconCopyButtonProps>(
  ({ copied, onCopy, copyTitle = "Copy", onClick, className, children, ...props }, ref) => {
    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onCopy();
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

export { IconCopyButton };
export type { IconCopyButtonProps };
