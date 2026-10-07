// Re-run steps for an existing project, or render review stills.
//   tsx scripts/render.ts <projectId> [fromStep]     e.g. storyboard
//   tsx scripts/render.ts <projectId> --stills <dir>
import { execFileSync } from "node:child_process";
import { getProject, latestStoryboard } from "../src/lib/store";
import { startPipeline } from "../src/pipeline/run";
import { renderStills } from "../src/pipeline/render";
import type { StepName } from "../src/lib/schema";

async function main() {
  const [id, a, b] = process.argv.slice(2);
  if (!id || !(await getProject(id))) throw new Error("usage: render.ts <projectId> [fromStep | --stills dir]");
  if (a === "--stills") {
    const rec = await latestStoryboard(id);
    if (!rec) throw new Error("no storyboard");
    const fpb = (30 * 60) / rec.json.bpm;
    const frames = rec.json.scenes.flatMap((s) => {
      const st = Math.round(s.startBeat * fpb), len = Math.round(s.lengthBeats * fpb);
      return s.layout === "montage" ? (s.montage ?? []).map((_, i) => Math.min(869, Math.round((s.startBeat + i + 0.6) * fpb))) : [st + 2, st + Math.round(len * 0.55), Math.min(869, st + len - 2)];
    });
    const out = await renderStills(id, rec.json, [...new Set(frames)].filter((f) => f < 870), b ?? `.data/stills/${id}`);
    const dir = b ?? `.data/stills/${id}`;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-pattern_type", "glob", "-i", `${dir}/f*.jpg`, "-vf", "scale=270:-1,tile=8x3:padding=4:color=black", "-frames:v", "1", `${dir}/sheet.jpg`]);
    console.log(`${out.length} stills → ${dir}/sheet.jpg`);
  } else {
    await startPipeline(id, (a as StepName) ?? "storyboard", "render");
    const p = await getProject(id);
    for (const [k, v] of Object.entries(p!.steps)) console.log(`${k.padEnd(11)} ${v.status.padEnd(6)} ${v.note ?? ""} ${v.error ?? ""}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
