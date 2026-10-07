"use client";
import { Player, type PlayerRef } from "@remotion/player";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QaIssue, Scene, Storyboard } from "@/lib/schema";
import { Reel } from "@/remotion/Reel";
import type { ReelProps } from "@/remotion/context";
import { api, fileUrl } from "./api";
import { Inspector } from "./Inspector";
import { BrandPanel, Downloads, QaPanel } from "./panels";
import type { ProjectData } from "./ProjectView";

const ROLE_COLORS: Record<Scene["role"], string> = { hook: "bg-brand", reveal: "bg-violet-500", benefit: "bg-sky-500", proof: "bg-amber-500", recap: "bg-emerald-500", cta: "bg-ink" };

export function Editor({ id, data, reload }: { id: string; data: ProjectData; reload: () => void }) {
  const [sb, setSb] = useState<Storyboard>(data.storyboard!.json);
  const [qa, setQa] = useState<QaIssue[]>(data.storyboard!.qa);
  const [selected, setSelected] = useState<string>(data.storyboard!.json.scenes[0]?.id);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [musicUrl, setMusicUrl] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [tab, setTab] = useState<"qa" | "brand" | "downloads">(data.renders.length ? "downloads" : "qa");
  const player = useRef<PlayerRef>(null);
  const editSeq = useRef(0);
  const assets = data.assets;
  const fpb = (30 * 60) / sb.bpm;

  // Live QA + re-placement after each edit (debounced; stale responses are dropped).
  const qaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback((fn: (draft: Storyboard) => void) => {
    setSb((prev) => {
      const next = structuredClone(prev);
      fn(next);
      const seq = ++editSeq.current;
      if (qaTimer.current) clearTimeout(qaTimer.current);
      qaTimer.current = setTimeout(async () => {
        try {
          const res = await api<{ storyboard: Storyboard; qa: QaIssue[] }>(`/api/projects/${id}/qa`, { method: "POST", json: { storyboard: next } });
          if (seq === editSeq.current) { setSb(res.storyboard); setQa(res.qa); }
        } catch { /* keep draft */ }
      }, 450);
      return next;
    });
    setDirty(true);
  }, [id]);

  // Score follows the cut: re-render the composer track when sections or the track change.
  const sectionKey = JSON.stringify([sb.musicTrackId, sb.bpm, sb.scenes.map((s) => [s.role, s.startBeat])]);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ url: string | null }>(`/api/projects/${id}/score`, { method: "POST", json: { storyboard: sb } }).then((r) => setMusicUrl(r.url)).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionKey, id]);

  const props: ReelProps = useMemo(() => ({
    storyboard: sb, kit: data.kit!, assets, assetBase: "",
    product: { title: data.product!.title, brand: data.product!.brand, price: data.product!.price },
    logo: data.product!.logo ? { path: data.product!.logo.path, width: data.product!.logo.width, height: data.product!.logo.height } : null,
    musicUrl,
  }), [sb, data, assets, musicUrl]);

  const scene = sb.scenes.find((s) => s.id === selected);
  const seek = (s: Scene) => player.current?.seekTo(Math.round(s.startBeat * fpb) + 3);

  async function save(note?: string) {
    setBusy("Saving");
    try {
      const rec = await api<{ json: Storyboard; qa: QaIssue[] }>(`/api/projects/${id}/storyboard`, { method: "PUT", json: { storyboard: sb, note } });
      setSb(rec.json); setQa(rec.qa); setDirty(false);
      return true;
    } catch (e) { alert((e as Error).message); return false; } finally { setBusy(""); }
  }
  async function render() {
    if (dirty && !(await save())) return;
    setBusy("Starting render");
    try {
      await api(`/api/projects/${id}/render`, { method: "POST", json: {} }).catch(async (e: Error) => {
        if (/QA has/.test(e.message) && confirm(`${e.message}\n\nRender anyway?`)) return api(`/api/projects/${id}/render`, { method: "POST", json: { force: true } });
        throw e;
      });
      setTab("downloads");
      reload();
    } catch (e) { alert((e as Error).message); } finally { setBusy(""); }
  }
  async function regenerate() {
    if (dirty && !confirm("Discard unsaved edits and regenerate?")) return;
    setBusy("Regenerating");
    try { await api(`/api/projects/${id}/run`, { method: "POST", json: { from: "storyboard", until: "storyboard", instruction } }); reload(); }
    catch (e) { alert((e as Error).message); setBusy(""); }
  }
  async function regenerateScene(sceneId: string, note: string) {
    setBusy("Rewriting scene");
    try {
      const res = await api<{ storyboard: Storyboard; qa: QaIssue[] }>(`/api/projects/${id}/scene`, { method: "POST", json: { storyboard: sb, sceneId, instruction: note } });
      setSb(res.storyboard); setQa(res.qa); setDirty(true);
    } catch (e) { alert((e as Error).message); } finally { setBusy(""); }
  }
  async function fix(issueId: string) {
    const res = await api<{ storyboard: Storyboard; qa: QaIssue[]; applied: string[] }>(`/api/projects/${id}/qa`, { method: "POST", json: { storyboard: sb, fix: issueId } });
    setSb(res.storyboard); setQa(res.qa); setDirty(true);
  }
  function changeTrack(trackId: string) {
    const t = data.tracks.find((x) => x.id === trackId);
    if (!t) return;
    update((d) => {
      const k = t.bpm / d.bpm;
      d.musicTrackId = t.id; d.beatOffsetSec = 0;
      for (const s of d.scenes) s.lengthBeats = Math.max(s.role === "recap" ? s.lengthBeats : 2, Math.round(s.lengthBeats * k));
      d.bpm = t.bpm;
    });
  }

  // drag to reorder
  const dragFrom = useRef<number | null>(null);
  const onDrop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;
    update((d) => { const [s] = d.scenes.splice(from, 1); d.scenes.splice(to, 0, s); });
  };

  const errors = qa.filter((q) => q.severity === "error").length;
  const working = data.project.running || !!busy;

  return (
    <div className="space-y-4">
      <div className="card p-3 flex flex-wrap items-center gap-2">
        <select className="input w-auto h-9" value={sb.musicTrackId} onChange={(e) => changeTrack(e.target.value)} title="Music">
          {data.tracks.map((t) => <option key={t.id} value={t.id}>♪ {t.title} · {t.bpm} BPM</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted" title="Voiceover needs ELEVENLABS_API_KEY (Phase 1: off)">
          <input type="checkbox" disabled checked={sb.voiceover} readOnly /> Voiceover
        </label>
        <div className="flex-1 min-w-[240px] flex gap-2">
          <input className="input h-9" placeholder='Direction for a full rewrite — "make it more premium", "lead with the price"' value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          <button className="btn-ghost h-9 whitespace-nowrap" disabled={working} onClick={regenerate}>Regenerate</button>
        </div>
        <button className="btn-ghost h-9" disabled={!dirty || working} onClick={() => save()}>{dirty ? "Save" : "Saved"}</button>
        <button className="btn-primary h-9" disabled={working} onClick={render}>{busy || "Render MP4"}</button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_340px]">
        {/* scenes */}
        <ol className="card p-2 space-y-1 max-h-[78vh] overflow-y-auto order-2 lg:order-1">
          {sb.scenes.map((s, i) => {
            const a = assets.find((x) => x.id === (s.assetId ?? s.montage?.[0]?.assetId));
            const issues = qa.filter((q) => q.sceneId === s.id && q.severity === "error").length;
            const text = s.overlays.find((o) => o.kind === "slamText") as { text?: string } | undefined;
            return (
              <li key={s.id} draggable onDragStart={() => (dragFrom.current = i)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(i)}
                onClick={() => { setSelected(s.id); seek(s); }}
                className={`flex gap-2 p-1.5 rounded-xl cursor-pointer border ${selected === s.id ? "border-ink bg-stone-50" : "border-transparent hover:bg-stone-50"}`}>
                <div className="w-10 h-[70px] rounded-md overflow-hidden flex-none" style={{ background: s.bg ?? data.kit!.colors.bg }}>
                  {a && <img src={fileUrl(a.path)} alt="" className="w-full h-full object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${ROLE_COLORS[s.role]}`} />
                    <span className="text-xs font-semibold capitalize">{s.role}</span>
                    <span className="text-[11px] text-muted ml-auto">{((s.lengthBeats * 60) / sb.bpm).toFixed(1)}s</span>
                  </div>
                  <div className="text-[11px] text-muted truncate">{s.layout}{s.montage ? ` · ${s.montage.length} cuts` : ""}</div>
                  <div className="text-xs truncate">{text?.text ?? s.montage?.map((m) => m.label).join(" · ") ?? ""}</div>
                  {issues > 0 && <div className="text-[10px] text-red-600 font-medium">{issues} QA issue{issues > 1 ? "s" : ""}</div>}
                </div>
              </li>
            );
          })}
          <li className="text-[10px] text-muted text-center pt-1">Drag to reorder · timing snaps to beats</li>
        </ol>

        {/* preview */}
        <div className="order-1 lg:order-2 flex flex-col items-center">
          <div className="w-full max-w-[min(420px,100%)] rounded-2xl overflow-hidden shadow-xl bg-black" style={{ aspectRatio: "9 / 16" }}>
            <Player ref={player} component={Reel as unknown as React.FC<Record<string, unknown>>} inputProps={props as unknown as Record<string, unknown>}
              durationInFrames={870} fps={30} compositionWidth={1080} compositionHeight={1920}
              style={{ width: "100%", height: "100%" }} controls loop clickToPlay acknowledgeRemotionLicense />
          </div>
          <div className="text-xs text-muted mt-2">29.00s · 1080×1920 · {sb.bpm} BPM · storyboard v{data.storyboard!.version}{dirty ? " (edited)" : ""}</div>
        </div>

        {/* inspector */}
        <div className="order-3 card p-4 max-h-[78vh] overflow-y-auto">
          {scene ? <Inspector key={scene.id} scene={scene} sb={sb} assets={assets} update={update} onRegenerate={(note) => regenerateScene(scene.id, note)} busy={working} /> : <p className="text-sm text-muted">Select a scene.</p>}
        </div>
      </div>

      <div className="card">
        <div className="flex gap-1 border-b border-line px-3 pt-2">
          {(["qa", "brand", "downloads"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === t ? "border-ink font-medium" : "border-transparent text-muted"}`}>
              {t === "qa" ? `QA ${errors ? `· ${errors} to fix` : "· passing"}` : t === "brand" ? "Brand kit" : `Downloads${data.renders.length ? ` · ${data.renders.length}` : ""}`}
            </button>
          ))}
        </div>
        <div className="p-4">
          {tab === "qa" && <QaPanel qa={qa} scenes={sb.scenes} onFix={fix} />}
          {tab === "brand" && <BrandPanel id={id} kit={data.kit!} onSaved={reload} />}
          {tab === "downloads" && <Downloads renders={data.renders} />}
        </div>
      </div>
    </div>
  );
}
