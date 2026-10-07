"use client";
import { useState } from "react";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
    if (!res.ok) return setErr("Wrong password");
    location.href = new URLSearchParams(location.search).get("next") || "/";
  }
  return (
    <main className="min-h-[70vh] grid place-items-center px-5">
      <form onSubmit={submit} className="card p-6 w-full max-w-sm space-y-3">
        <h1 className="font-semibold text-lg">Sign in</h1>
        <input type="password" className="input" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button className="btn-primary w-full">Continue</button>
      </form>
    </main>
  );
}
