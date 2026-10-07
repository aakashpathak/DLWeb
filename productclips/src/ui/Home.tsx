"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, fileUrl } from "./api";

type Row = { id: string; url: string; status: string; createdAt: string; title?: string; brand?: string; poster?: string | null };

export function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => { api<Row[]>("/api/projects").then(setRows).catch(() => setRows([])); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const p = await api<{ id: string }>("/api/projects", { method: "POST", json: { url, authorized } });
      router.push(`/p/${p.id}`);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <main className="mx-auto max-w-[1400px] px-5">
      <section className="py-16 md:py-24 max-w-2xl">
        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.05]">Your product page,<br />now a scroll-stopping reel.</h1>
        <p className="mt-4 text-muted text-lg">Paste a product URL. Get a 29-second vertical reel built from the page’s real images, copy and design language — cut to the beat.</p>
        <form onSubmit={submit} className="mt-8 space-y-3">
          <div className="flex gap-2">
            <input className="input h-12 text-base flex-1" placeholder="https://brand.com/products/…" value={url} onChange={(e) => setUrl(e.target.value)} required type="url" />
            <button className="btn-primary h-12 px-6 text-base" disabled={busy || !authorized || !url}>{busy ? "Starting…" : "Make my clip"}</button>
          </div>
          <label className="flex items-start gap-2 text-sm text-muted cursor-pointer select-none">
            <input type="checkbox" className="mt-0.5 accent-black" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
            I own this product page or am authorized to market it.
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <p className="text-sm text-muted">Site blocks bots? <Link className="underline" href="/new">Upload images and paste the copy</Link> instead.</p>
        </form>
      </section>

      <section className="pb-20">
        <h2 className="label mb-4">Recent projects</h2>
        {rows === null ? <p className="text-muted text-sm">Loading…</p> : rows.length === 0 ? <p className="text-muted text-sm">No clips yet.</p> : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {rows.map((r) => (
              <Link key={r.id} href={`/p/${r.id}`} className="group">
                <div className="aspect-[9/16] rounded-xl overflow-hidden bg-stone-200 border border-line relative">
                  {r.poster && <img src={fileUrl(r.poster)} alt="" className="w-full h-full object-cover group-hover:scale-[1.02] transition" />}
                  <span className={`absolute top-2 left-2 text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full ${r.status === "ready" ? "bg-white text-ink" : r.status === "running" ? "bg-brand text-white" : r.status === "new" ? "bg-white text-muted" : "bg-red-600 text-white"}`}>{r.status}</span>
                </div>
                <div className="mt-2 text-sm font-medium truncate">{r.title ?? new URL(r.url).hostname}</div>
                <div className="text-xs text-muted truncate">{r.brand ?? r.url}</div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
