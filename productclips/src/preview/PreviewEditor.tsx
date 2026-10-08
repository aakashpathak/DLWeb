"use client";
import { Player, type PlayerRef } from "@remotion/player";
import { useCallback, useMemo, useRef, useState } from "react";
import { finalize } from "@/lib/director";
import { autoFix, runQa } from "@/lib/qa";
import type { AnalyzedAsset, BrandKit, Product, QaIssue, Scene, Storyboard } from "@/lib/schema";
import { Reel } from "@/remotion/Reel";
import type { ReelProps } from "@/remotion/context";
import { fileUrl } from "@/ui/api";
import { Inspector } from "@/ui/Inspector";
import { QaPanel } from "@/ui/panels";

export type DemoData = { product: Product; kit: BrandKit; assets: AnalyzedAsset[]; storyboard: Storyboard; musicPath: string | null; mp4: string | null };

const ROLE_COLORS: Record<Scene["role"], string> = { hook: "bg-brand", reveal: "bg-violet-500", benefit: "bg-sky-500", proof: "bg-amber-500", recap: "bg-emerald-500", cta: "bg-ink" };

/** Same editor as the app, with QA and re-layout running in the browser instead of the server. */
export function PreviewEditor({ data }: { data: DemoData }) {
  const ctx = useMemo(() => ({ product: data.product, kit: data.kit, assets: data.assets }), [data]);
  const [sb, setSb] = useState<Storyboard>(data.storyboard);
  const [qa, setQa] = useState<QaIssue[]>(() => runQa(data.storyboard, ctx));
  const [selected, setSelected] = useState(data.storyboard.scenes[0].id);
  const [edited, setEdited] = useState(false);
  const [tab, setTab] = useState<"qa" | "mp4">("qa");
  const player = useRef<PlayerRef>(null);
  const fpb = (30 * 60) / sb.bpm;

  const update = useCallback((fn: (d: Storyboard) => void) => {
    setSb((prev) => {
      const next = structuredClone(prev);
      fn(next);
      const placed = finalize(next, ctx);
      setQa(runQa(placed, ctx));
      return placed;
    });
    setEdited(true);
  }, [ctx]);

  const props: ReelProps = useMemo(() => ({
    storyboard: sb, kit: data.kit, assets: data.assets, assetBase: ".",
    product: { title: data.product.title, brand: data.product.brand, price: data.product.price },
    logo: data.product.logo ? { path: data.product.logo.path, width: data.product.logo.width, height: data.product.logo.height } : null,
    musicUrl: data.musicPath ? `./api/files/${data.musicPath}` : null,
  }), [sb, data]);

  const scene = sb.scenes.find((s) => s.id === selected);
  const dragFrom = useRef<number | null>(null);
  const onDrop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;
    update((d) => { const [s] = d.scenes.splice(from, 1); d.scenes.splice(to, 0, s); });
  };
  const errors = qa.filter((q) => q.severity === "error").length;

  return (
    <div className="space-y-4">
      <div className="card p-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{data.product.brand} · {data.product.title}</span>
        <span className="text-muted">{sb.bpm} BPM · 29.00s · 1080×1920</span>
        <span className="flex-1" />
        <button className="btn-ghost h-9" disabled={!edited} onClick={() => { setSb(data.storyboard); setQa(runQa(data.storyboard, ctx)); setEdited(false); }}>Reset edits</button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)_330px]">
        <ol className="card p-2 space-y-1 lg:max-h-[78vh] overflow-y-auto order-2 lg:order-1">
          {sb.scenes.map((s, i) => {
            const a = data.assets.find((x) => x.id === (s.assetId ?? s.montage?.[0]?.assetId));
            const issues = qa.filter((q) => q.sceneId === s.id && q.severity === "error").length;
            const text = s.overlays.find((o) => o.kind === "slamText") as { text?: string } | undefined;
            return (
              <li key={s.id} draggable onDragStart={() => (dragFrom.current = i)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(i)}
                onClick={() => { setSelected(s.id); player.current?.seekTo(Math.round(s.startBeat * fpb) + 3); }}
                className={`flex gap-2 p-1.5 rounded-xl cursor-pointer border ${selected === s.id ? "border-ink bg-stone-50" : "border-transparent hover:bg-stone-50"}`}>
                <div className="w-10 h-[70px] rounded-md overflow-hidden flex-none" style={{ background: s.bg ?? data.kit.colors.bg }}>
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

        <div className="order-1 lg:order-2 flex flex-col items-center">
          <div className="w-full max-w-[400px] rounded-2xl overflow-hidden shadow-xl bg-black" style={{ aspectRatio: "9 / 16" }}>
            <Player ref={player} component={Reel as unknown as React.FC<Record<string, unknown>>} inputProps={props as unknown as Record<string, unknown>}
              durationInFrames={870} fps={30} compositionWidth={1080} compositionHeight={1920}
              style={{ width: "100%", height: "100%" }} controls loop clickToPlay acknowledgeRemotionLicense />
          </div>
          <p className="text-xs text-muted mt-2 text-center max-w-[400px]">Press play for sound. Edits re-time and re-place text instantly; the music stays scored to the original cut.</p>
        </div>

        <div className="order-3 card p-4 lg:max-h-[78vh] overflow-y-auto">
          {scene ? <Inspector key={scene.id} scene={scene} sb={sb} assets={data.assets} update={update} onRegenerate={() => {}} busy={true} /> : null}
        </div>
      </div>

      <div className="card">
        <div className="flex gap-1 border-b border-line px-3 pt-2">
          <button onClick={() => setTab("qa")} className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === "qa" ? "border-ink font-medium" : "border-transparent text-muted"}`}>QA {errors ? `· ${errors} to fix` : "· passing"}</button>
          {data.mp4 && <button onClick={() => setTab("mp4")} className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === "mp4" ? "border-ink font-medium" : "border-transparent text-muted"}`}>Rendered MP4</button>}
        </div>
        <div className="p-4">
          {tab === "qa" && <QaPanel qa={qa} scenes={sb.scenes} onFix={async (id) => { const r = autoFix(sb, ctx, id === "all" ? undefined : id); setSb(r.sb); setQa(runQa(r.sb, ctx)); setEdited(true); }} />}
          {tab === "mp4" && data.mp4 && (
            <div className="flex flex-wrap gap-4 items-start">
              <video src={`./api/files/${data.mp4}`} controls playsInline className="w-full max-w-[300px] rounded-xl border border-line" />
              <p className="text-sm text-muted max-w-sm">The final file the render worker produced from this storyboard: H.264, 29.00s, 1080×1920, audio mastered to −14 LUFS.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
