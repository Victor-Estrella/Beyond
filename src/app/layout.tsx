import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Jost } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Jost: a light geometric sans for the title and labels.
const sans = Jost({
  subsets: ["latin"],
  weight: ["200", "300", "400", "500"],
  variable: "--font-sans",
  display: "swap",
});

// Instrument Serif: an elegant counterpoint for the narrative lines.
const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "BEYOND — A Journey Through the Unknown",
  description:
    "A cinematic, scroll-driven journey through the cosmos: from the silence of the void, through nebulae, to the event horizon of a black hole.",
};

export const viewport: Viewport = {
  themeColor: "#020207",
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
