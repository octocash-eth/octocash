import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof globalThis === "undefined" || typeof localStorage === "undefined") return defaultTheme;
    return (localStorage.getItem(storageKey) as Theme) || defaultTheme;
  });
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() => {
    if (typeof globalThis === "undefined" || typeof globalThis.matchMedia === "undefined") {
      return theme === "dark" ? "dark" : "light";
    }
    if (theme === "system") {
      return globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return theme === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    if (typeof globalThis === "undefined" || typeof globalThis.document === "undefined") return;
    const root = globalThis.document.documentElement;
    root.classList.remove("light", "dark");

    const systemTheme =
      typeof globalThis.matchMedia !== "undefined" && globalThis.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";

    const applied = theme === "system" ? systemTheme : theme;
    root.classList.add(applied);
    setResolvedTheme(applied);
  }, [theme]);

  useEffect(() => {
    if (typeof globalThis === "undefined" || typeof globalThis.matchMedia === "undefined" || theme !== "system") {
      return;
    }
    const media = globalThis.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      setResolvedTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  const setTheme = (t: Theme) => {
    if (typeof globalThis !== "undefined" && typeof localStorage !== "undefined") {
      localStorage.setItem(storageKey, t);
    }
    setThemeState(t);
  };

  const value = { theme, resolvedTheme, setTheme };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
};
