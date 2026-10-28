// Ring connection through the unofficial ring-client-api (same login the Ring Android app uses).
// Turns Ring push notifications, camera history and alarm sensors into plain events
// for triage.js, and runs the two actions: secure the home and take a live snapshot.
import { RingApi } from 'ring-client-api';
import { RingRestClient } from 'ring-client-api/rest-client';
import { kindFromText } from './triage.js';

const SNAP_KINDS = new Set(['person', 'doorbell', 'loitering', 'package', 'package_pickup']);

// --- linking: email + password, then the 2FA code Ring texts/emails ----------------
let pendingLogin = null;
export async function startLink(email, password) {
  const client = new RingRestClient({ email, password, controlCenterDisplayName: 'Home Manager' });
  try {
    const auth = await client.getCurrentAuth();
    return { refreshToken: auth.refresh_token };
  } catch (e) {
    if (!client.promptFor2fa) throw e;
    pendingLogin = client;
    return { needsCode: true, prompt: client.promptFor2fa };
  }
}
export async function finishLink(code) {
  if (!pendingLogin) throw Object.assign(new Error('Start the sign-in again.'), { status: 400 });
  try {
    const auth = await pendingLogin.getAuth(String(code).trim());
    pendingLogin = null;
    return { refreshToken: auth.refresh_token };
  } catch (e) {
    throw Object.assign(new Error(pendingLogin?.promptFor2fa || e.message), { status: 400 });
  }
}

// --- live connection ------------------------------------------------------------
export async function connectRing({ refreshToken, onToken, onEvent, log = console.log }) {
  const api = new RingApi({ refreshToken, controlCenterDisplayName: 'Home Manager', cameraStatusPollingSeconds: 30 });
  api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => onToken(newRefreshToken));

  const [locations, cameras] = await Promise.all([api.getLocations(), api.getCameras()]);
  const profile = await api.getProfile().catch(() => null);
  const byId = new Map(cameras.map((c) => [String(c.id), c]));
  log(`[ring] ${cameras.length} cameras, ${locations.length} locations`);

  for (const cam of cameras) {
    cam.onNewNotification.subscribe((n) => {
      const ding = n.data?.event?.ding || {};
      const kind = kindFromText({
        category: n.android_config?.category,
        subtype: ding.subtype,
        detection: ding.detection_type || n.data?.event?.eventito?.type,
        body: n.android_config?.body,
      });
      onEvent({
        id: String(ding.id || `${cam.id}-${Date.now()}`),
        at: ding.created_at ? new Date(ding.created_at).toISOString() : new Date().toISOString(),
        deviceId: String(cam.id), deviceName: cam.name, kind,
        detail: n.android_config?.body || '',
        snapshotUuid: n.img?.snapshot_uuid || null,
        live: true,
      });
    });
  }

  // Alarm sensors (contact/tilt, e.g. a garage door) and the siren.
  let armed = false;
  for (const loc of locations) {
    if (!loc.hasAlarmBaseStation) continue;
    loc.getAlarmMode().then((m) => { armed = m !== 'none'; }).catch(() => {});
    const devices = await loc.getDevices().catch(() => []);
    for (const d of devices) {
      if (/sensor\.(contact|tilt)/.test(d.deviceType)) {
        let last = d.data.faulted;
        d.onData.subscribe((data) => {
          if (data.faulted === last || data.faulted == null) return;
          last = data.faulted;
          onEvent({ id: `${d.zid}-${Date.now()}`, at: new Date().toISOString(), deviceId: d.zid, deviceName: d.name, kind: 'sensor', open: !!data.faulted, live: true });
        });
      }
      if (d.deviceType === 'security-panel') {
        let lastAlarm = d.data.alarmInfo?.state;
        d.onData.subscribe((data) => {
          armed = data.mode && data.mode !== 'none';
          const s = data.alarmInfo?.state;
          if (s && s !== lastAlarm) onEvent({ id: `alarm-${Date.now()}`, at: new Date().toISOString(), deviceId: d.zid, deviceName: 'Ring Alarm', kind: 'alarm', detail: `Ring Alarm: ${s.replace(/-/g, ' ')}.`, live: true });
          lastAlarm = s;
        });
      }
    }
  }

  return {
    account: profile?.profile?.email || null,
    firstName: profile?.profile?.first_name || null,
    get armed() { return armed; },
    cameras: cameras.map((c) => ({ id: String(c.id), name: c.name, hasLight: c.hasLight, doorbell: c.isDoorbot })),
    hasAlarm: locations.some((l) => l.hasAlarmBaseStation),

    // Today's camera history so the summary isn't empty after a restart.
    async history() {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const out = [];
      for (const cam of cameras) {
        const res = await cam.getEvents({ limit: 50 }).catch(() => ({ events: [] }));
        for (const e of res.events || []) {
          if (Date.parse(e.created_at) < start.getTime()) continue;
          const det = e.cv_properties?.detection_type || (e.cv_properties?.person_detected ? 'human' : '');
          out.push({
            id: e.ding_id_str || String(e.ding_id), at: new Date(e.created_at).toISOString(),
            deviceId: String(cam.id), deviceName: cam.name,
            kind: kindFromText({ subtype: e.kind, detection: typeof det === 'string' ? det : '' }), live: false,
          });
        }
      }
      return out;
    },

    async snapshot(deviceId, uuid) {
      const cam = byId.get(String(deviceId));
      if (!cam) return null;
      return uuid ? cam.getSnapshot({ uuid }).catch(() => cam.getSnapshot()) : cam.getSnapshot();
    },
    wantsSnapshot: (ev) => SNAP_KINDS.has(ev.kind) && byId.has(ev.deviceId),

    // "Secure home": arm the alarm (Away) and switch on every camera light.
    async secure() {
      const done = [];
      for (const loc of locations) {
        if (!loc.hasAlarmBaseStation) continue;
        await loc.setAlarmMode('all');
        armed = true;
        done.push(`Armed ${loc.name || 'Ring Alarm'} (Away)`);
      }
      for (const cam of cameras.filter((c) => c.hasLight)) {
        await cam.setLight(true).then(() => done.push(`Turned on ${cam.name} light`)).catch(() => {});
      }
      if (!done.length) done.push('No alarm or camera lights to switch on');
      return done;
    },

    disconnect: () => api.disconnect(),
  };
}
