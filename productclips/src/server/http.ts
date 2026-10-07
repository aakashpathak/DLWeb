import { NextResponse } from "next/server";
import { getProject } from "@/lib/store";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const fail = (message: string, status = 400) => NextResponse.json({ error: message }, { status });

export async function projectOr404(id: string) {
  try { return await getProject(id); } catch { return null; }
}

export async function handle(fn: () => Promise<Response>) {
  try { return await fn(); } catch (e) {
    console.error(e);
    return fail((e as Error).message || "Something went wrong", 500);
  }
}
