# Runway backend — the brain on your own computer

A tiny server (one file, Node.js) that turns "dentist Thursday at 8, 45 minutes away" into a
backwards-planned timeline. The phone app sends the sentence here; this server asks either
**Claude** (Anthropic API) or a **local model** running on the same computer through
[Ollama](https://ollama.com), and sends the plan back. Your API key lives here, never on the phone.

```
Runway app (phone)  →  https://your-server/plan  →  Claude API   (PROVIDER=claude)
                                                 ↘  Ollama       (PROVIDER=ollama, on this computer)
```

## Setup on the spare computer (Mac, Windows, or Linux; ~15 minutes)

1. **Install Node.js** (LTS) from https://nodejs.org and, if you want a local model, **Ollama** from https://ollama.com.
2. **Get the code.** Install Git from https://git-scm.com if needed, then in a terminal:
   ```bash
   git clone https://github.com/aakashpathak/DLWeb.git
   cd DLWeb/runway/backend
   npm install
   copy .env.example .env      # Windows
   cp .env.example .env        # Mac / Linux
   ```
3. **Edit `.env`** (any text editor):
   - To use **Claude**: keep `PROVIDER=claude` and paste your key into `ANTHROPIC_API_KEY=`.
   - To use a **local model**: set `PROVIDER=ollama`, then in the terminal run `ollama pull qwen2.5:7b`
     (about 4.7 GB; needs ~8 GB RAM. On a weak machine try `qwen2.5:3b`; on a strong one `qwen2.5:14b` plans better).
   - Set `RUNWAY_TOKEN=` to any password you like. You'll type the same thing into the app.
4. **Start it:**
   ```bash
   npm start
   ```
   You should see `Runway backend on http://localhost:8787 provider=… auth=on`.
5. **Test it** in a second terminal window:
   ```bash
   RUNWAY_TOKEN=yourpassword node check.mjs
   ```
   It prints a full plan for a sample sentence. (Windows PowerShell: `$env:RUNWAY_TOKEN="yourpassword"; node check.mjs`.)

## Let your phone reach it (the important bit)

Your phone can't see `localhost` on another computer. The easiest bridge is a free Cloudflare tunnel:

1. Install `cloudflared`: Mac `brew install cloudflared`; Windows/Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. In a third terminal window:
   ```bash
   cloudflared tunnel --url http://localhost:8787
   ```
   It prints a line like `https://random-words.trycloudflare.com`. That's your server's public address.
3. On the phone: Runway → gear → **AI planning** → paste that URL into **Runway server URL** and your password into **Server password**. It says *Connected* when it works.

Notes:
- The quick tunnel URL changes every time you restart `cloudflared`. For a permanent URL, make a free Cloudflare account and a *named* tunnel (their docs: "Create a tunnel"), or use Tailscale Funnel.
- Keep the two terminals (server + tunnel) running. To run them in the background permanently, use `pm2` (`npm i -g pm2 && pm2 start server.js --name runway && pm2 save`) and a named tunnel as a service.
- Same Wi-Fi only? You can skip the tunnel and use `http://<computer's LAN IP>:8787` — but iPhone Safari blocks plain-http calls from an https page, so this only works when testing the app from `http://localhost` on that same computer. Use the tunnel for the phone.

## Which brain?

| | Claude (`PROVIDER=claude`) | Local model (`PROVIDER=ollama`) |
|---|---|---|
| Quality | Excellent. Understands "takes me three hours, leave at six, must be done" | Decent with `qwen2.5:7b`; the server double-checks and repairs the plan's shape, but time math can be off. `14b` is noticeably better |
| Speed | 5–20 s | 10–60 s depending on the computer (GPU helps a lot) |
| Cost | A few cents per plan | Free, uses your electricity |
| Privacy | Text goes to Anthropic | Never leaves your computer |

Switch any time by editing `.env` and restarting `npm start`.

## API (for the curious)

- `GET /health` → `{ ok, provider, model, auth }`
- `POST /plan` with `Authorization: Bearer <RUNWAY_TOKEN>` and body `{ "text": "...", "prefs": {…}, "tz": "America/Los_Angeles" }` → `{ plan, model, provider }`.
  The plan shape is defined in `../plan-contract.js`, shared with the app.
