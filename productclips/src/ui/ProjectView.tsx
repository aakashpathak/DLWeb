"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalyzedAsset, BrandKit, Product, Project, QaIssue, RenderRecord, StepName, Storyboard } from "@/lib/schema";
import { api, fileUrl } from "./api";
import { Editor } from "./Editor";

export type ProjectData = {
  project: Project & { running: boolean };
  product: Product | null;
  kit: BrandKit | null;
  assets: AnalyzedAsset[];
  storyboard: { version: number; json: Storyboard; qa: QaIssue[]; createdBy: string; note?: string } | null;
  renders: RenderRecord[];
  versions: { version: number; createdBy: string; createdAt: string; note?: string }[];
  tracks: { id: string; title: string; bpm: number; mood: string; energy: number; license: string }[];
};

const LABELS: Record<StepName, string> = { ingest: "Scraping", brand: "Reading the brand", analyze: "Analyzing images", storyboard: "Writing the storyboard", render: "Rendering" };

export function ProjectView({ id }: { id: string }) {
  const [data, setData] = useState<ProjectData | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<ProjectData>(`/api/projects/${id}`);
      setData(d);
      const busy = d.project.running || d.project.status === "running" || d.renders.some((r) => r.status === "rendering");
      if (timer.current) clearTimeout(timer.current);
      if (busy) timer.current = setTimeout(load, 1500);
    } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { load(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [load]);

  async function rerun(from: StepName, until: StepName = "render") {
    try { await api(`/api/projects/${id}/run`, { method: "POST", json: { from, until } }); load(); } catch (e) { alert((e as Error).message); }
  }

  if (error) return <main className="mx-auto max-w-3xl p-10 text-red-600">{error}</main>;
  if (!data) return <main className="mx-auto max-w-3xl p-10 text-muted">Loading…</main>;
  const { project, product } = data;
  const running = project.running;

  return (
    <main className="mx-auto max-w-[1400px] px-5 py-6 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="label">{product?.brand ?? "New project"}</div>
          <h1 className="text-2xl font-semibold tracking-tight truncate">{product?.title ?? project.url}</h1>
          <a href={project.url} target="_blank" rel="noreferrer" className="text-xs text-muted hover:underline truncate block max-w-xl">{project.url}</a>
        </div>
      </div>

      <ol className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {(Object.keys(LABELS) as StepName[]).map((s, i) => {
          const st = project.steps[s];
          return (
            <li key={s} className={`card p-3 ${st.status === "running" ? "ring-2 ring-brand/60" : ""}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold"><span className="text-muted mr-1">{i + 1}</span>{LABELS[s]}</span>
                <StatusDot status={st.status} />
              </div>
              <div className="text-[11px] text-muted mt-1 min-h-[2.4em] line-clamp-2">{st.error ? <span className="text-red-600">{st.error}</span> : st.note ?? (st.status === "pending" ? "Waiting" : st.status)}</div>
              {!running && st.status !== "pending" && (
                <button className="text-[11px] underline text-muted hover:text-ink mt-1" onClick={() => rerun(s, s === "render" ? "render" : "storyboard")}>Re-run{s !== "storyboard" && s !== "render" ? " from here" : ""}</button>
              )}
            </li>
          );
        })}
      </ol>

      {project.status === "blocked" && (
        <div className="card p-4 border-amber-300 bg-amber-50 text-sm">
          This site blocks automated reading. <Link className="underline font-medium" href="/new">Upload images and paste the product copy</Link> instead — we don’t try to get around bot protection.
        </div>
      )}

      {product && data.assets.length === 0 && product.assets.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">{product.assets.map((a) => <img key={a.id} src={fileUrl(a.path)} alt="" className="h-28 rounded-lg border border-line" />)}</div>
      )}

      {data.storyboard && data.kit && product ? (
        <Editor key={`${data.storyboard.version}`} id={id} data={data} reload={load} />
      ) : (
        <div className="card p-10 text-center text-muted text-sm">{running ? "Working… the editor opens as soon as the storyboard is written." : "No storyboard yet."}</div>
      )}
    </main>
  );
}

function StatusDot({ status }: { status: string }) {
  const c = status === "done" ? "bg-emerald-500" : status === "running" ? "bg-brand animate-pulse" : status === "error" ? "bg-red-500" : "bg-stone-300";
  return <span className={`w-2 h-2 rounded-full ${c}`} />;
}
