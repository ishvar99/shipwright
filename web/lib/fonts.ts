import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";

// Variable names match the Portfolio so the ported token CSS works unchanged.
export const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display-face",
  display: "swap",
});

// Geist Sans beside Geist Mono: one family for prose and code, the precision-tool register.
export const sans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

export const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});
