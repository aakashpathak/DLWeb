"use client";
import { useState } from "react";
import type { BrandKit, QaIssue, RenderRecord, Scene } from "@/lib/schema";
import { api, fileUrl } from "./api";

export function QaPanel({ qa, scenes, onFix }: { qa: QaIssue[]; scenes: Scene[]; onFix: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState("");
  if (!qa.length) return <p className="text-sm text-emerald-700">All section-9 checks pass: 29.00s, safe zones, contrast, crops, text economy, sources, image reuse.</p>;
  const run = async (id: string) => { setBusy(id); try { await onFix(id); } finally { setBusy(""); } };
  return (
    <div className="space-y-2">
      {qa.some((q) => q.fix) && <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => run("all")}>Fix all automatically</button>}
      <ul className="divide-y divide-line">
        {qa.map((q) => {
          const s = scenes.find((x) => x.id === q.sceneId);
          return (
            <li key={q.id} className="py-2 flex items-center gap-3 text-sm">
              <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${q.severity === "error" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>{q.severity}</span>
              <span className="flex-1">{s && <span className="text-muted capitalize">{s.role}: </span>}{q.message}</span>
              {q.fix && <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => run(q.id)} title={q.fix}>{busy === q.id ? "…" : q.fix}</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const TONES: BrandKit["tone"][] = ["premium-minimal", "playful-bold", "clean-clinical", "warm-natural", "techy", "luxury"];

export function BrandPanel({ id, kit, onSaved }: { id: string; kit: BrandKit; onSaved: () => void }) {
  const [colors, setColors] = useState(kit.colors);
  const [tone, setTone] = useState(kit.tone);
  const [energy, setEnergy] = useState(kit.energy);
  const [cta, setCta] = useState(kit.ctaText);
  const [shape, setShape] = useState(kit.shape.style);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api(`/api/projects/${id}/brand`, { method: "PUT", json: { colors, tone, energy, ctaText: cta, shapeStyle: shape } }); onSaved(); }
    catch (e) { alert((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="grid md:grid-cols-[1fr_1fr_auto] gap-6 text-sm">
      <div>
        <div className="label mb-2">Colours</div>
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(colors) as (keyof BrandKit["colors"])[]).map((k) => (
            <label key={k} className="flex items-center gap-2 rounded-lg border border-line p-1.5">
              <input type="color" value={colors[k]} onChange={(e) => setColors({ ...colors, [k]: e.target.value })} className="w-7 h-7 rounded" />
              <span className="text-xs">{k}<br /><span className="text-muted font-mono text-[10px]">{colors[k]}</span></span>
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <div>
          <div className="label mb-1">Type</div>
          <div className="text-xs">Headings: <b>{kit.fonts.heading.family}</b> {kit.fonts.heading.weight}{kit.fonts.heading.sourceFamily && kit.fonts.heading.sourceFamily !== kit.fonts.heading.family ? <span className="text-muted"> (page uses {kit.fonts.heading.sourceFamily})</span> : null}</div>
          <div className="text-xs">Body: <b>{kit.fonts.body.family}</b> · Buttons: <b>{kit.fonts.button.family}</b></div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1"><span className="label">Tone</span><select className="input h-9" value={tone} onChange={(e) => setTone(e.target.value as BrandKit["tone"])}>{TONES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="space-y-1"><span className="label">Energy {energy}/5</span><input type="range" min={1} max={5} value={energy} onChange={(e) => setEnergy(+e.target.value)} className="w-full mt-2" /></label>
          <label className="space-y-1"><span className="label">CTA text</span><input className="input h-9" value={cta} onChange={(e) => setCta(e.target.value)} /></label>
          <label className="space-y-1"><span className="label">Shape</span><select className="input h-9" value={shape} onChange={(e) => setShape(e.target.value as BrandKit["shape"]["style"])}>{["pill", "rounded", "sharp"].map((t) => <option key={t}>{t}</option>)}</select></label>
        </div>
      </div>
      <div className="flex md:flex-col gap-2 items-start">
        <div className="rounded-xl p-4 w-40" style={{ background: colors.bg, color: colors.ink, fontFamily: kit.fonts.heading.family }}>
          <div className="text-lg leading-tight" style={{ fontWeight: kit.fonts.heading.weight }}>Headline</div>
          <span className="inline-block mt-2 px-3 py-1 text-xs" style={{ background: colors.primary, color: colors.onPrimary, borderRadius: shape === "pill" ? 999 : shape === "sharp" ? 0 : 8 }}>{cta}</span>
          <span className="inline-block mt-2 ml-1 w-3 h-3 rounded-full align-middle" style={{ background: colors.accent }} />
        </div>
        <button className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Apply to reel"}</button>
      </div>
    </div>
  );
}

export function Downloads({ renders }: { renders: RenderRecord[] }) {
  const [copied, setCopied] = useState("");
  if (!renders.length) return <p className="text-sm text-muted">No renders yet. Hit “Render MP4”.</p>;
  return (
    <ul className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {renders.map((r) => (
        <li key={r.id} className="space-y-2">
          <div className="aspect-[9/16] rounded-xl overflow-hidden bg-stone-100 border border-line grid place-items-center">
            {r.status === "done" && r.mp4 ? <video src={fileUrl(r.mp4)} poster={fileUrl(r.poster)} controls playsInline className="w-full h-full object-cover" />
              : r.status === "error" ? <span className="text-xs text-red-600 p-3">{r.error}</span>
              : <div className="w-2/3"><div className="h-1.5 rounded bg-stone-200 overflow-hidden"><div className="h-full bg-brand transition-all" style={{ width: `${Math.round(r.progress * 100)}%` }} /></div><div className="text-xs text-muted mt-2 text-center">Rendering {Math.round(r.progress * 100)}%</div></div>}
          </div>
          <div className="text-xs text-muted">v{r.storyboardVersion} · {new Date(r.createdAt).toLocaleString()}{r.lufs != null && Number.isFinite(r.lufs) ? ` · ${r.lufs.toFixed(1)} LUFS` : ""}</div>
          {r.status === "done" && (
            <div className="flex flex-wrap gap-1.5">
              <a className="btn-primary btn-sm" href={`${fileUrl(r.mp4)}?download`}>MP4</a>
              <a className="btn-ghost btn-sm" href={`${fileUrl(r.poster)}?download`}>Poster</a>
              <a className="btn-ghost btn-sm" href={`${fileUrl(r.gif)}?download`}>GIF</a>
              <button className="btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(location.origin + fileUrl(r.mp4)); setCopied(r.id); setTimeout(() => setCopied(""), 1500); }}>{copied === r.id ? "Copied" : "Copy link"}</button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
