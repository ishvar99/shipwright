import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { display, mono, sans } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shipwright",
  description: "Finds where to change code, and shows you why.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} ${display.variable}`}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
