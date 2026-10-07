import { NextResponse, type NextRequest } from "next/server";
import { authToken } from "./src/server/auth";

// Single-user password gate. Disabled when APP_PASSWORD is unset (local use).
export async function proxy(req: NextRequest) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return NextResponse.next();
  if (req.cookies.get("pc_auth")?.value === (await authToken(pw))) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!login|api/login|_next/|favicon).*)"] };
