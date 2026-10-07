# ProductClips

Paste a D2C product URL → get a **29.00-second, 1080×1920 reel** made from the page's real images, real copy and design language (fonts, colours, button shape, tone), cut to a music beat.

```
URL → ingest → brand kit → asset analysis → storyboard (+QA) → preview/edit → render → MP4 · poster · GIF
```

## Run it

```bash
cd productclips
npm install
cp .env.example .env.local      # add ANTHROPIC_API_KEY for Claude copy + vision
npm run build && npm start      # http://localhost:3000
```

Needs Node 20+, `ffmpeg` on PATH, and a Chromium (auto-detected from Playwright's browser cache, or set `CHROMIUM_PATH`).

Offline end-to-end demo (fictional brand "Halden", generated product photos, no network needed):

```bash
npm run demo                    # scrape → … → MP4, prints file paths
npm run demo -- https://…       # same pipeline on any URL your network can reach
npm test                        # 18 tests: beat map, 29.00s timing, QA, crop safety, copy rules, audio
```

## How it works

| Step | Code | What it does |
|---|---|---|
| Ingest | `src/pipeline/ingest.ts`, `page-extract.ts` | Playwright at 1440 + 390 wide; dismisses popups, scrolls for lazy loads. Shopify `/products/<handle>.js` fast path → JSON-LD → OpenGraph → DOM. Max-res images (srcset + CDN param rewrite), perceptual-hash dedupe, logo (SVG or img), screenshots. Respects robots.txt and stops on 403/bot walls → manual upload. |
| Brand kit | `brand.ts`, `fonts.ts` | Computed styles of body, H1, buy button, links, badges + screenshot palette → `bg/ink/primary/onPrimary/accent/muted`. Google Fonts used as-is (woff2 downloaded); licensed faces mapped to the closest free match. Radius → pill/rounded/sharp. Tone + energy from Claude (screenshot + copy), heuristic fallback. |
| Analysis | `analyze.ts`, `images.ts` | Pixel stats for every image (12×12 luma grid for contrast, backdrop colour, packshot subject box, saliency). Claude vision adds type, subject/text/face boxes, pinnable details ("cap", "sole"), disclaimers and which benefits each image shows. |
| Storyboard | `storyboard.ts`, `lib/plan.ts`, `lib/director.ts` | Claude writes a **creative plan** (words + image choices + what to point at), with the section-6 rules in the prompt. The **director** turns it into beats and pixels: bar-aligned beat map, text placement that avoids subject/faces/safe zones, contrast-driven plates, zoom limits that never crop baked-in text, packshot framing. The model never writes coordinates or frame numbers. |
| QA | `lib/qa.ts` | Every section-9 check, run live in the editor and before render, each with a deterministic one-click fix. AI storyboards that still fail get one Claude repair pass. |
| Music | `lib/audio-synth.ts`, `music.ts` | Built-in composer scores each reel **to its own cut**: drop on the reveal, build into the recap, outro under the end card (owned, royalty-free). Upload licensed tracks (BPM + downbeat offset) via `POST /api/music`. 9 synthesized SFX on the beat. |
| Render | `render.ts`, `src/remotion/*` | Remotion → H.264 High, CRF 18, yuv420p/bt709, AAC 192k/48k, `+faststart`, exactly 870 frames. ffmpeg two-pass loudnorm to −14 LUFS / −1.5 dBTP, 0.8s fade. Poster from the hook, 2s GIF of the reveal. |

Motion library (`src/remotion/components/motion.tsx`): slam text (1.7×→1 in 260ms, lines on consecutive beats, real-width fit), CTA-styled pills, stickers, stroke-drawn highlight rings that follow the camera, arrows, ripples, lights-off flicker, star rating filling per beat, price tag, feature chips, pulsing CTA, logo, flash/whip/zoom-through/drop-in transitions — all pure functions of the frame, reading colours/fonts/radius from the brand kit and the beat from a shared clock.

## Editor

Live Remotion Player preview; scenes list (drag to reorder, timing snaps to beats); inspector to swap image, edit text, pin/nudge position, change layout/camera/transition, rewrite one scene with Claude; music picker (re-scores instantly); full regenerate with a direction ("make it more premium"); brand-kit overrides; QA report with fixes; downloads (MP4, poster, GIF, copy link).

## Phase 1 status — honest notes

- **Storage** is the local filesystem (`.data/`), behind `src/lib/store.ts`. `supabase/migrations/0001_init.sql` mirrors it table-for-table; the Supabase adapter isn't written yet.
- **Jobs** run in-process with per-step persistence and re-run from any step; no Inngest/Trigger.dev yet (one render at a time per project).
- **Auth**: set `APP_PASSWORD` for the single-user gate.
- **Not built yet**: ElevenLabs voiceover (toggle is present, disabled), product-video b-roll, Tesseract OCR cross-check.
- Without `ANTHROPIC_API_KEY` everything still works but copy is plainer and images can't be matched to benefits or checked for baked-in text — use the key for real output.
- Verified in development against the bundled demo store only; the build sandbox couldn't reach real D2C sites, so the 5-URL acceptance run (Warby Parker, Allbirds, Glossier, Away, Brooklinen) is still to do.
