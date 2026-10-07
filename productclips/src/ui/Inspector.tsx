"use client";
import { useState } from "react";
import type { AnalyzedAsset, Overlay, SafePos, Scene, Storyboard } from "@/lib/schema";
import { fileUrl } from "./api";

const POSITIONS: SafePos[] = ["top", "upper", "center", "lower", "bottom"];
const LAYOUTS: Scene["layout"][] = ["fullBleed", "card", "split", "textOnly"];
const MOVES: Scene["camera"]["move"][] = ["pushIn", "pullOut", "panLeft", "panRight", "punch", "static"];
const TRANSITIONS: Scene["transitionIn"][] = ["cut", "flash", "whip", "zoomThrough", "dropIn"];

type Props = { scene: Scene; sb: Storyboard; assets: AnalyzedAsset[]; update: (fn: (d: Storyboard) => void) => void; onRegenerate: (note: string) => void; busy: boolean };

export function Inspector({ scene, sb, assets, update, onRegenerate, busy }: Props) {
  const [note, setNote] = useState("");
  const edit = (fn: (s: Scene) => void) => update((d) => { const s = d.scenes.find((x) => x.id === scene.id); if (s) fn(s); });
  const editOv = (i: number, fn: (o: Overlay) => void) => edit((s) => fn(s.overlays[i]));
  const usable = assets.filter((a) => a.kind !== "screenshot");
  const secs = (scene.lengthBeats * 60) / sb.bpm;
  const isLast = sb.scenes[sb.scenes.length - 1]?.id === scene.id;

  return (
    <div className="space-y-5 text-sm">
      <div className="flex items-center justify-between">
        <div><div className="label">Scene</div><div className="font-semibold capitalize">{scene.role}</div></div>
        <div className="text-right">
          <div className="label">Length</div>
          <div className="flex items-center gap-1">
            <button className="btn-ghost btn-sm w-7 px-0" disabled={isLast || scene.lengthBeats <= 2} onClick={() => edit((s) => { s.lengthBeats -= 1; })}>−</button>
            <span className="w-16 text-center tabular-nums">{secs.toFixed(1)}s</span>
            <button className="btn-ghost btn-sm w-7 px-0" disabled={isLast} onClick={() => edit((s) => { s.lengthBeats += 1; })}>+</button>
          </div>
          <div className="text-[10px] text-muted">{scene.lengthBeats.toFixed(1)} beats{isLast ? " · fills to 29s" : ""}</div>
        </div>
      </div>

      {scene.layout !== "endCard" && scene.layout !== "montage" && (
        <div className="grid grid-cols-3 gap-2">
          <Select label="Layout" value={scene.layout} options={LAYOUTS} onChange={(v) => edit((s) => { s.layout = v as Scene["layout"]; })} />
          <Select label="Camera" value={scene.camera.move} options={MOVES} onChange={(v) => edit((s) => { s.camera.move = v as Scene["camera"]["move"]; if (v === "punch" && s.camera.toScale <= s.camera.fromScale) s.camera.toScale = s.camera.fromScale * 1.06; })} />
          <Select label="Cut in" value={scene.transitionIn} options={TRANSITIONS} onChange={(v) => edit((s) => { s.transitionIn = v as Scene["transitionIn"]; })} />
        </div>
      )}

      {scene.layout !== "montage" && (
        <div>
          <div className="label mb-2">Image</div>
          <div className="grid grid-cols-5 gap-1.5">
            {usable.map((a) => (
              <button key={a.id} title={`${a.analysis.type} · ${a.width}×${a.height}${a.analysis.lowRes ? " · low-res" : ""}`} onClick={() => edit((s) => { s.assetId = a.id; s.camera.origin = a.analysis.focalPoint; })}
                className={`aspect-[3/4] rounded-md overflow-hidden border-2 relative ${scene.assetId === a.id ? "border-ink" : "border-transparent opacity-80 hover:opacity-100"}`}>
                <img src={fileUrl(a.path)} alt="" className="w-full h-full object-cover" />
                <span className="absolute bottom-0 inset-x-0 text-[8px] bg-black/55 text-white truncate px-0.5">{a.analysis.type}</span>
              </button>
            ))}
            {scene.layout === "textOnly" && <button onClick={() => edit((s) => { s.assetId = undefined; })} className="aspect-[3/4] rounded-md border-2 border-dashed border-line text-[10px] text-muted">none</button>}
          </div>
        </div>
      )}

      {scene.montage && (
        <div className="space-y-2">
          <div className="label">Cuts (one per beat)</div>
          {scene.montage.map((m, i) => (
            <div key={i} className="flex gap-2 items-center">
              <select className="input h-9 w-28" value={m.assetId} onChange={(e) => edit((s) => { s.montage![i].assetId = e.target.value; })}>
                {usable.map((a) => <option key={a.id} value={a.id}>{a.analysis.type} {a.id.slice(0, 4)}</option>)}
              </select>
              <input className="input h-9" value={m.label ?? ""} onChange={(e) => edit((s) => { s.montage![i].label = e.target.value; })} placeholder="Label" />
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div className="label">On screen</div>
        {scene.overlays.map((o, i) => <OverlayEditor key={i} o={o} onChange={(fn) => editOv(i, fn)} onRemove={() => edit((s) => { s.overlays.splice(i, 1); })} />)}
        {scene.layout !== "endCard" && (
          <div className="flex gap-2">
            <button className="btn-ghost btn-sm" onClick={() => edit((s) => { s.overlays.push({ kind: "slamText", text: "New headline", atBeat: 0, position: "upper", style: "headline" }); })}>+ Headline</button>
            <button className="btn-ghost btn-sm" onClick={() => edit((s) => { s.overlays.push({ kind: "pill", text: "Supporting fact", atBeat: 1, position: "lower" }); })}>+ Pill</button>
          </div>
        )}
      </div>

      {scene.sourceRefs.length > 0 && <div className="text-[11px] text-muted">Copy sourced from: {scene.sourceRefs.join(", ")}</div>}

      <div className="border-t border-line pt-4 space-y-2">
        <div className="label">Regenerate this scene</div>
        <input className="input" placeholder="Optional note — “focus on the cap”" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn-ghost w-full" disabled={busy} onClick={() => onRegenerate(note)}>Rewrite with Claude</button>
      </div>
    </div>
  );
}

function OverlayEditor({ o, onChange, onRemove }: { o: Overlay; onChange: (fn: (o: Overlay) => void) => void; onRemove: () => void }) {
  const head = (
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-semibold text-muted">{o.kind} · beat {o.atBeat}</span>
      <button className="text-[11px] text-muted hover:text-red-600" onClick={onRemove}>remove</button>
    </div>
  );
  if (o.kind === "slamText" || o.kind === "pill") {
    const words = o.text.trim().split(/\s+/).filter(Boolean).length;
    const max = o.kind === "slamText" ? 6 : 4;
    return (
      <div className="rounded-xl border border-line p-2.5 space-y-2">
        {head}
        <input className="input" value={o.text} onChange={(e) => onChange((x) => { (x as typeof o).text = e.target.value; })} />
        <div className={`text-[10px] ${words > max ? "text-red-600" : "text-muted"}`}>{words}/{max} words{o.kind === "slamText" ? " · lines of ≤3 slam on consecutive beats" : ""}</div>
        <div className="flex gap-2 items-center">
          <select className="input h-8 w-28" value={o.position} onChange={(e) => onChange((x) => { const t = x as typeof o; t.position = e.target.value as SafePos; t.nudge = undefined; t.pinned = true; })}>
            {POSITIONS.map((p) => <option key={p}>{p}</option>)}
          </select>
          <input type="range" min={-160} max={160} step={4} className="flex-1" value={o.nudge?.[1] ?? 0} title="Nudge up/down"
            onChange={(e) => onChange((x) => { const t = x as typeof o; t.nudge = [0, Number(e.target.value)]; t.pinned = true; })} />
          {o.pinned && <button className="text-[10px] underline text-muted" title="Let the layout engine place it" onClick={() => onChange((x) => { const t = x as typeof o; t.pinned = false; t.nudge = undefined; })}>auto</button>}
        </div>
      </div>
    );
  }
  if (o.kind === "sticker" || o.kind === "cta" || o.kind === "price") {
    return <div className="rounded-xl border border-line p-2.5 space-y-2">{head}<input className="input" value={o.text} onChange={(e) => onChange((x) => { (x as typeof o).text = e.target.value; })} /></div>;
  }
  if (o.kind === "chips") {
    return <div className="rounded-xl border border-line p-2.5 space-y-2">{head}<input className="input" value={o.items.join(", ")} onChange={(e) => onChange((x) => { (x as typeof o).items = e.target.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4); })} /><div className="text-[10px] text-muted">comma separated, ≤3 words each</div></div>;
  }
  if (o.kind === "rating") {
    return <div className="rounded-xl border border-line p-2.5 space-y-2">{head}<div className="text-xs">{o.stars ? `${o.stars} ★` : "no rating"}{o.count ? ` · ${o.count} reviews` : ""}</div><input className="input" placeholder="Review quote (≤10 words, real)" value={o.quote ?? ""} onChange={(e) => onChange((x) => { (x as typeof o).quote = e.target.value || undefined; })} /></div>;
  }
  return <div className="rounded-xl border border-line p-2.5">{head}</div>;
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="block space-y-1">
      <span className="label">{label}</span>
      <select className="input h-9 px-2 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o}>{o}</option>)}</select>
    </label>
  );
}
