import { ExternalLink } from "lucide-react";
import * as React from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface IconLinkButtonProps extends React.ComponentProps<typeof Button> {
  href: string;
  linkTitle?: string;
}

const IconLinkButton = React.forwardRef<HTMLButtonElement, IconLinkButtonProps>(
  ({ href, linkTitle = "Open link", className, children, onClick, ...props }, ref) => {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.stopPropagation();
      onClick?.(e as unknown as React.MouseEvent<HTMLButtonElement>);
    };

    return (
      <Button
        ref={ref}
        variant="ghost"
        size="icon"
        asChild
        className={cn("size-5 rounded-sm p-0", className)}
        title={linkTitle}
        {...props}
      >
        <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick}>
          {children ?? <ExternalLink className="size-3" />}
        </a>
      </Button>
    );
  },
);

IconLinkButton.displayName = "IconLinkButton";

export type { IconLinkButtonProps };
export { IconLinkButton };
