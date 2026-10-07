// Persistence. Phase 1 runs on the local filesystem so the app works with zero
// setup; every write goes through this module, so swapping in Supabase
// (schema in supabase/migrations) only means re-implementing these functions.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  STEPS, type AnalyzedAsset, type BrandKit, type Product, type Project, type QaIssue,
  type RenderRecord, type StepName, type Storyboard,
} from "./schema";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), ".data"));

export const newId = (n = 10) => crypto.randomBytes(16).toString("base64url").replace(/[-_]/g, "").slice(0, n).toLowerCase();

const pdir = (id: string) => path.join(DATA_DIR, "projects", id);

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return null; }
}
async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file); // atomic, so pollers never read half a file
}

// ---------- projects ----------
export async function createProject(url: string, authorized: boolean): Promise<Project> {
  const id = newId();
  const steps = Object.fromEntries(STEPS.map((s) => [s, { status: "pending" }])) as Project["steps"];
  const project: Project = { id, url, status: "new", createdAt: new Date().toISOString(), steps, authorized };
  await writeJson(path.join(pdir(id), "project.json"), project);
  return project;
}
export const getProject = (id: string) => readJson<Project>(path.join(pdir(safeId(id)), "project.json"));
export async function saveProject(p: Project) { await writeJson(path.join(pdir(p.id), "project.json"), p); }

// Read-modify-write; serialised per project so concurrent step updates don't clobber.
const locks = new Map<string, Promise<unknown>>();
export async function updateProject(id: string, fn: (p: Project) => void): Promise<Project> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const p = await getProject(id);
    if (!p) throw new Error(`project ${id} not found`);
    fn(p);
    await saveProject(p);
    return p;
  });
  locks.set(id, next.catch(() => {}));
  return next;
}
export async function setStep(id: string, step: StepName, patch: Partial<Project["steps"][StepName]>) {
  return updateProject(id, (p) => {
    p.steps[step] = { ...p.steps[step], ...patch };
    if (patch.status === "running") p.steps[step].startedAt = new Date().toISOString();
    if (patch.status === "done" || patch.status === "error") p.steps[step].finishedAt = new Date().toISOString();
  });
}

export async function listProjects(): Promise<Project[]> {
  const root = path.join(DATA_DIR, "projects");
  const ids = await fs.readdir(root).catch(() => [] as string[]);
  const out = (await Promise.all(ids.map((id) => getProject(id)))).filter(Boolean) as Project[];
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function safeId(id: string) {
  if (!/^[a-z0-9]{4,32}$/.test(id)) throw new Error("bad id");
  return id;
}

// ---------- step outputs ----------
export const getProduct = (id: string) => readJson<Product>(path.join(pdir(id), "product.json"));
export const saveProduct = (id: string, p: Product) => writeJson(path.join(pdir(id), "product.json"), p);
export const getBrandKit = (id: string) => readJson<BrandKit>(path.join(pdir(id), "brandkit.json"));
export const saveBrandKit = (id: string, b: BrandKit) => writeJson(path.join(pdir(id), "brandkit.json"), b);
export const getAssets = async (id: string) => (await readJson<AnalyzedAsset[]>(path.join(pdir(id), "assets.json"))) ?? [];
export const saveAssets = (id: string, a: AnalyzedAsset[]) => writeJson(path.join(pdir(id), "assets.json"), a);
export const getExtras = async (id: string) => (await readJson<Record<string, unknown>>(path.join(pdir(id), "extras.json"))) ?? {};
export const saveExtras = (id: string, e: Record<string, unknown>) => writeJson(path.join(pdir(id), "extras.json"), e);

export type StoryboardRecord = { version: number; json: Storyboard; qa: QaIssue[]; createdBy: "ai" | "user" | "heuristic"; createdAt: string; note?: string };
export async function listStoryboards(id: string): Promise<StoryboardRecord[]> {
  const dir = path.join(pdir(id), "storyboards");
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const recs = (await Promise.all(files.map((f) => readJson<StoryboardRecord>(path.join(dir, f))))).filter(Boolean) as StoryboardRecord[];
  return recs.sort((a, b) => a.version - b.version);
}
export async function latestStoryboard(id: string) {
  const all = await listStoryboards(id);
  return all[all.length - 1] ?? null;
}
export async function saveStoryboard(id: string, rec: Omit<StoryboardRecord, "version" | "createdAt">) {
  const all = await listStoryboards(id);
  const version = (all[all.length - 1]?.version ?? 0) + 1;
  const full: StoryboardRecord = { ...rec, version, createdAt: new Date().toISOString() };
  await writeJson(path.join(pdir(id), "storyboards", `v${String(version).padStart(4, "0")}.json`), full);
  return full;
}

export const getRenders = async (id: string) => (await readJson<RenderRecord[]>(path.join(pdir(id), "renders.json"))) ?? [];
export async function upsertRender(id: string, r: RenderRecord) {
  return updateLocked(`${id}:renders`, async () => {
    const all = await getRenders(id);
    const i = all.findIndex((x) => x.id === r.id);
    if (i >= 0) all[i] = { ...all[i], ...r }; else all.unshift(r);
    await writeJson(path.join(pdir(id), "renders.json"), all);
  });
}
async function updateLocked(key: string, fn: () => Promise<void>) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// ---------- files ----------
/** Storage path relative to DATA_DIR; served at /api/files/<path>. */
export async function putFile(rel: string, data: Buffer | Uint8Array) {
  const abs = resolveFile(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
  return rel;
}
export function resolveFile(rel: string) {
  const abs = path.resolve(DATA_DIR, rel);
  if (!abs.startsWith(DATA_DIR + path.sep)) throw new Error("path escapes data dir");
  return abs;
}
export const projectFile = (id: string, ...parts: string[]) => path.posix.join("projects", id, "files", ...parts);
export const fileUrl = (rel: string) => `/api/files/${rel}`;
