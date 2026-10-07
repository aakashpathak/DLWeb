/** Cookie value for the single-user password gate (Web Crypto so it runs in the proxy too). */
export async function authToken(password: string) {
  const data = new TextEncoder().encode(`productclips:${password}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
