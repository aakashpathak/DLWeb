// Apple push (APNs) with a .p8 key, no dependencies. Used only for events that need attention.
import http2 from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const b64url = (b) => Buffer.from(b).toString('base64url');

export function createApns({ keyFile, keyId, teamId, topic, production }) {
  if (!keyFile || !keyId || !teamId || !topic || !existsSync(keyFile)) return null;
  const key = createPrivateKey(readFileSync(keyFile));
  const host = production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  let jwt = null, jwtAt = 0;
  const token = () => {
    // Apple wants the token refreshed at most every 20 min and at least every 60.
    if (jwt && Date.now() - jwtAt < 40 * 60_000) return jwt;
    const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
    const body = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
    jwt = `${head}.${body}.${b64url(sig)}`; jwtAt = Date.now();
    return jwt;
  };

  // Resolves to { ok, status, reason } per device token.
  function sendOne(deviceToken, payload) {
    return new Promise((resolve) => {
      const client = http2.connect(host);
      client.on('error', (e) => resolve({ ok: false, status: 0, reason: e.message }));
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${token()}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0, data = '';
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        client.close();
        let reason = '';
        try { reason = JSON.parse(data).reason || ''; } catch {}
        resolve({ ok: status === 200, status, reason });
      });
      req.end(JSON.stringify(payload));
    });
  }

  return {
    async notify(deviceTokens, { title, body, eventId }) {
      const payload = { aps: { alert: { title, body }, sound: 'default', 'interruption-level': 'time-sensitive' }, eventId };
      return Promise.all(deviceTokens.map(async (t) => ({ token: t, ...(await sendOne(t, payload)) })));
    },
  };
}
