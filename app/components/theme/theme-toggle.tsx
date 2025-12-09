import { Moon, Sun } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useTheme } from "./theme-provider";

export function ThemeToggle({ variant = "outline" }: { variant?: "outline" | "ghost" }) {
  const { resolvedTheme, setTheme } = useTheme();

  const toggleTheme = () => {
    // Toggle based on what's actually displayed (resolvedTheme), not the theme setting
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  return (
    <Button variant={variant} size="icon" onClick={toggleTheme}>
      <Moon className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
      <Sun className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
