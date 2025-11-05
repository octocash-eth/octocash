import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export function ThemeMeta() {
  return (
    <>
      <meta name="color-scheme" content="light dark" />
      <script
        dangerouslySetInnerHTML={{
          __html: `
        (function () {
          var k = "theme"; // "light" | "dark"
          var root = document.documentElement;
          var mql = window.matchMedia("(prefers-color-scheme: dark)");
          var persisted = localStorage.getItem(k);
          var t = (persisted === "light" || persisted === "dark")
            ? persisted
            : (mql.matches ? "dark" : "light");
          root.classList.toggle("dark", t === "dark");
          root.setAttribute("data-theme", t);
          // Avoid first-frame transitions
          root.classList.add("no-theme-transition");
          requestAnimationFrame(() => root.classList.remove("no-theme-transition"));
        })();`,
        }}
      />
      <style dangerouslySetInnerHTML={{ __html: `.no-theme-transition * { transition: none !important; }` }} />
      {/* Fallback for users with JavaScript disabled - defaults to light theme */}
      <noscript>
        <style
          dangerouslySetInnerHTML={{
            __html: `
            :root {
              color-scheme: light;
            }
            html.dark {
              color-scheme: light;
            }
          `,
          }}
        />
      </noscript>
    </>
  );
}

type Theme = "light" | "dark" | "system";
type Ctx = { theme: Theme; resolvedTheme: "light" | "dark"; setTheme: (t: Theme) => void };
export const ThemeContext = createContext<Ctx>({ theme: "system", resolvedTheme: "light", setTheme: () => {} });

const STORAGE_KEY = "theme";

function getInitial(): { theme: Theme; resolved: "light" | "dark" } {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") {
      // This was set by the head script before paint
      return { theme: (localStorage.getItem(STORAGE_KEY) as Theme) ?? "system", resolved: attr };
    }
  }
  // Fallback (should rarely run with the head script present)
  const persisted = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  if (persisted === "light" || persisted === "dark") return { theme: persisted, resolved: persisted };
  const prefersDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return { theme: "system", resolved: prefersDark ? "dark" : "light" };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [{ theme, resolved }, setState] = useState(getInitial);

  const mql = useMemo(
    () => (typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null),
    [],
  );

  // Keep <html> and storage in sync whenever theme changes
  useEffect(() => {
    const root = document.documentElement;
    const nextResolved = theme === "system" ? (mql?.matches ? "dark" : "light") : theme;
    root.classList.toggle("dark", nextResolved === "dark");
    root.setAttribute("data-theme", nextResolved);
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
    setState((s) => ({ ...s, resolved: nextResolved }));
  }, [theme, mql]);

  // React to OS changes while in "system"
  useEffect(() => {
    if (!mql) return;
    const onChange = () => setState((s) => ({ ...s, resolved: mql.matches ? "dark" : "light" }));
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [mql]);

  const setTheme = useCallback((t: Theme) => setState((s) => ({ ...s, theme: t })), []);

  return <ThemeContext.Provider value={{ theme, resolvedTheme: resolved, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
