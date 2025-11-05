import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";

const defaultButtonStyles =
  "border border-border-button shadow-button disabled:shadow-none active:shadow-button-active text-button-primary-foreground hover:bg-primary/90 hover:text-primary-foreground dark:hover:text-white";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: `${defaultButtonStyles} bg-button-primary`,
        destructive: `${defaultButtonStyles} shadow-button-destructive bg-destructive border-destructive-shadow text-destructive-foreground hover:bg-destructive-hover hover:text-destructive-hover-foreground`,
        outline: `${defaultButtonStyles} shadow-none`,
        secondary: `${defaultButtonStyles} text-button-secondary-foreground bg-button-secondary hover:bg-accent hover:text-button-secondary-foreground`,
        ghost: `${defaultButtonStyles} bg-transparent border-transparent shadow-none active:shadow-none dark:hover:bg-accent/50 dark:hover:text-button-secondary-foreground`,
        link: `text-button-link-foreground hover:text-button-link-hover-foreground active:text-button-link-active-foreground`,
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        xl: "h-11 px-8 has-[>svg]:px-6 text-lg leading-medium",
        "2xl": "h-12 px-10 has-[>svg]:px-8 text-xl leading-medium",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    compoundVariants: [
      {
        variant: ["default", "destructive", "outline", "secondary", "ghost"],
        size: ["xl", "2xl"],
        class: "border-2 focus-visible:ring-[4px]",
      },
      {
        variant: ["default", "secondary"],
        size: ["xl", "2xl"],
        class: "shadow-[5px_5px_0_0_var(--color-violet-500)]",
      },
      {
        variant: "destructive",
        size: ["xl", "2xl"],
        class: "shadow-[5px_5px_0_0_var(--color-destructive-shadow)]",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  isLoading = false,
  disabled,
  children,
  onClick,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    isLoading?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  const isDisabledOrLoading = disabled || isLoading;

  // For non-button elements (when using asChild), we need additional
  // accessibility attributes and event handling since they don't support
  // the native disabled attribute
  const enhancedProps =
    asChild && isDisabledOrLoading
      ? {
          "aria-disabled": true,
          ...(isLoading && { "aria-busy": true }),
          tabIndex: -1,
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
            event.stopPropagation();
            // Don't call the original onClick when disabled/loading
          },
        }
      : {
          ...(onClick && { onClick }),
        };

  // When using asChild, Slot requires exactly one child element
  const content = asChild ? (
    children
  ) : (
    <>
      {isLoading && <Loader2 className="animate-spin" />}
      {children}
    </>
  );

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...(!asChild && { disabled: isDisabledOrLoading })}
      {...props}
      {...enhancedProps}
    >
      {content}
    </Comp>
  );
}

export { Button, buttonVariants };
