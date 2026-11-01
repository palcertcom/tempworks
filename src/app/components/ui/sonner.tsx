"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, ToasterProps } from "sonner";
import { useLanguage } from "../../../i18n/LanguageContext";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const { dir } = useLanguage();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      dir={dir}
      // Surface errors and confirmations at the top so they land
      // inside the user's eye-line instead of below the fold. The
      // app uses sonner as the canonical channel for transient
      // errors (~400 callsites) — a single position prop fixes all
      // of them at once. Callers can still override `position` per
      // toast.
      position="top-center"
      richColors
      closeButton
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
