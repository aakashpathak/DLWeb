"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ManualUpload() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previews, setPreviews] = useState<string[]>([]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError("");
    const res = await fetch("/api/manual", { method: "POST", body: new FormData(e.currentTarget) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error ?? "Upload failed"); setBusy(false); return; }
    router.push(`/p/${data.id}`);
  }

  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Upload images and paste the product copy</h1>
      <p className="text-muted mt-2">For sites that block automated reading. Everything in the reel will come from what you give here.</p>
      <form onSubmit={submit} className="mt-8 space-y-6">
        <div className="card p-5 space-y-3">
          <div className="label">Product images (highest resolution you have)</div>
          <input name="images" type="file" accept="image/*" multiple required onChange={(e) => setPreviews(Array.from(e.target.files ?? []).map((f) => URL.createObjectURL(f)))} />
          {previews.length > 0 && <div className="flex gap-2 overflow-x-auto">{previews.map((p) => <img key={p} src={p} alt="" className="h-24 rounded-lg border border-line" />)}</div>}
          <div className="label pt-2">Logo (optional)</div>
          <input name="logo" type="file" accept="image/*" />
        </div>
        <div className="card p-5 grid sm:grid-cols-2 gap-4">
          <Field name="title" label="Product name" required />
          <Field name="brand" label="Brand" />
          <Field name="price" label="Price" placeholder="$42" />
          <Field name="cta" label="Buy button text" placeholder="Add to bag" />
          <Field name="rating" label="Rating (0-5)" placeholder="4.8" />
          <Field name="reviewCount" label="Review count" placeholder="2314" />
          <Field name="url" label="Product URL (for reference)" />
        </div>
        <div className="card p-5 space-y-2">
          <div className="label">Product copy — one benefit per line</div>
          <textarea name="copy" className="input h-40 py-2" placeholder={"Keeps drinks cold for 24 hours\nLeakproof one-hand cap\n…"} />
          <div className="label pt-2">Real customer reviews (one per line, optional)</div>
          <textarea name="reviews" className="input h-24 py-2" />
        </div>
        <div className="card p-5">
          <div className="label mb-3">Brand colours (optional — otherwise read from the images)</div>
          <div className="flex flex-wrap gap-5">{["bg", "ink", "primary", "accent"].map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm"><input type="color" name={`color_${k}`} defaultValue={{ bg: "#ffffff", ink: "#111111", primary: "#111111", accent: "#ff5a36" }[k]} /> {k}</label>
          ))}</div>
        </div>
        <label className="flex items-start gap-2 text-sm text-muted"><input type="checkbox" name="authorized" className="mt-0.5 accent-black" required /> I own this product or am authorized to market it.</label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="btn-primary h-12 px-6" disabled={busy}>{busy ? "Uploading…" : "Make my clip"}</button>
      </form>
    </main>
  );
}

function Field({ name, label, ...rest }: { name: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className="space-y-1 block"><span className="label">{label}</span><input name={name} className="input" {...rest} /></label>;
}
