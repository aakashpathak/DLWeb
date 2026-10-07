import { NextResponse } from "next/server";
import { authToken } from "@/server/auth";

export async function POST(req: Request) {
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  const expected = process.env.APP_PASSWORD;
  if (!expected || password !== expected) return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set("pc_auth", await authToken(expected), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30, secure: process.env.NODE_ENV === "production" });
  return res;
}
