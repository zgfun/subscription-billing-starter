"use client";

import { ClientOnly, IconButton, Skeleton } from "@chakra-ui/react";
import { useTheme } from "next-themes";

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function ColorModeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <ClientOnly fallback={<Skeleton boxSize="9" rounded="md" />}>
      <IconButton
        aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        variant="ghost"
        size="sm"
        onClick={() => setTheme(dark ? "light" : "dark")}
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </IconButton>
    </ClientOnly>
  );
}
