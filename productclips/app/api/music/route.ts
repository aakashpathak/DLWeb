import { addLibraryTrack, allTracks } from "@/pipeline/music";
import { Tone } from "@/lib/schema";
import { fail, handle, json } from "@/server/http";

export const runtime = "nodejs";

export async function GET() { return handle(async () => json(await allTracks())); }

/** Add a licensed track: file + bpm + first-downbeat offset + mood/energy/tones + license. */
export async function POST(req: Request) {
  return handle(async () => {
    const f = await req.formData();
    const file = f.get("file");
    if (!file || typeof file !== "object" || !("arrayBuffer" in file)) return fail("Attach an audio file");
    const ext = (file.name.split(".").pop() ?? "mp3").toLowerCase();
    if (!["mp3", "wav", "m4a"].includes(ext)) return fail("Use mp3, wav or m4a");
    const bpm = parseFloat(String(f.get("bpm")));
    if (!(bpm > 40 && bpm < 220)) return fail("BPM is required");
    const tones = String(f.get("tones") ?? "").split(",").map((t) => t.trim()).filter((t) => Tone.safeParse(t).success) as Tone[];
    const track = await addLibraryTrack({
      title: String(f.get("title") || file.name), bpm, mood: String(f.get("mood") || "custom"), energy: Number(f.get("energy") || 3), tones,
      beatGrid: { offsetSec: parseFloat(String(f.get("offset") || "0")) || 0, beatsPerBar: 4 }, license: String(f.get("license") || "Supplied by owner"),
    }, Buffer.from(await file.arrayBuffer()), ext);
    return json(track, 201);
  });
}
