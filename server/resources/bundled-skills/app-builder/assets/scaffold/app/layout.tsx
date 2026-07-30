import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rudder App",
  description: "A full-stack app built with Rudder App Builder",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
