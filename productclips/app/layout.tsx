import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "ProductClips", description: "Your product page, now a scroll-stopping reel." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <header className="border-b border-line bg-white/80 backdrop-blur sticky top-0 z-20">
          <div className="mx-auto max-w-[1400px] px-5 h-14 flex items-center justify-between">
            <Link href="/" className="font-semibold tracking-tight text-[15px] flex items-center gap-2">
              <span className="inline-block w-5 h-8 rounded-[5px] bg-ink relative overflow-hidden"><span className="absolute inset-x-1 top-1.5 bottom-1.5 rounded-[3px] bg-brand" /></span>
              ProductClips
            </Link>
            <nav className="flex gap-4 text-sm text-muted">
              <Link href="/" className="hover:text-ink">Projects</Link>
              <Link href="/new" className="hover:text-ink">Manual upload</Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
