export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "content-type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}
/** Where stored files are served. The static preview build serves them relative to the page. */
const FILE_BASE = (globalThis as { __PC_FILE_BASE?: string }).__PC_FILE_BASE ?? "/api/files/";
export const fileUrl = (p?: string | null) => (p ? `${FILE_BASE}${p}` : "");
