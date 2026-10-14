"use client";

// Theme state for the whole app. Light is the default; dark is opted into and
// remembered in localStorage. The active theme is written to a `data-theme`
// attribute on <html>, which globals.css keys off ("dark" flips every token).
//
// A tiny blocking script in app/layout.tsx applies the stored theme before
// paint, so there is no flash. This provider syncs React state with what that
// script already set and owns toggling afterwards.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "autosploit-theme";

// Inline script source, injected in <head> before paint. Reads the stored
// choice and sets data-theme early so the first paint matches. Defaults to
// light on anything unexpected. Kept dependency-free and self-contained.
export const themeInitScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t!=='dark'&&t!=='light')t='light';document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function apply(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start from whatever the init script already put on <html> so the first
  // client render agrees with the server-rendered (light) markup and the
  // pre-paint script. Falls back to light outside the browser.
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof document === "undefined") return "light";
    return document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light";
  });

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    apply(t);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, t);
    } catch {
      // private mode / storage blocked: keep the in-memory theme, skip persist.
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  // Keep the DOM attribute in sync if state ever changes without going through
  // setTheme (e.g. hydration races).
  useEffect(() => {
    apply(theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
