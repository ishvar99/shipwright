import { Bricolage_Grotesque, Geist_Mono, Inter } from "next/font/google";

// Variable names match the Portfolio so the ported token CSS works unchanged.
export const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display-face",
  display: "swap",
});

export const sans = Inter({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

export const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});
