/* ============================================================================
   Daily Log — Push Worker (Cloudflare)
   - POST /subscribe    { subscription, time:"21:00", tz:"Asia/Seoul" }  → save
   - POST /unsubscribe  { endpoint }                                     → remove
   - GET  /vapidPublicKey                                                → key
   - cron (* * * * *): send a Web Push to each device at its chosen local time
   Web Push payload encryption (RFC 8291, aes128gcm) + VAPID (RFC 8292),
   implemented with Web Crypto and verified against the RFC test vectors.
   Bindings:  KV  -> SUBS
   Secrets:   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (base64url d), VAPID_SUBJECT
   Var:       ALLOWED_ORIGIN  (e.g. https://lnk111.github.io)
============================================================================ */

const enc = new TextEncoder();
const b64uToBuf = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bufToB64u = (b) => {
  let s = "";
  const a = new Uint8Array(b);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const concat = (...arrs) => {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8);
  return new Uint8Array(bits);
}
async function sha256Hex(str) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(str)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ---- aes128gcm payload encryption ---- */
async function encryptPayload(sub, plaintextStr) {
  const uaPublic = b64uToBuf(sub.keys.p256dh);     // 65 bytes
  const auth = b64uToBuf(sub.keys.auth);           // 16 bytes
  const plaintext = enc.encode(plaintextStr);

  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey)); // 65
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const IKM = await hkdf(auth, ecdh, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const CEK = await hkdf(salt, IKM, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const NONCE = await hkdf(salt, IKM, enc.encode("Content-Encoding: nonce\0"), 12);

  const record = concat(plaintext, new Uint8Array([0x02])); // last-record delimiter
  const aesKey = await crypto.subtle.importKey("raw", CEK, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: NONCE, tagLength: 128 }, aesKey, record));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  const idlen = new Uint8Array([asPublic.length]); // 65
  return concat(salt, rs, idlen, asPublic, ct);
}

/* ---- VAPID (RFC 8292) ---- */
async function importVapidKey(env) {
  const pub = b64uToBuf(env.VAPID_PUBLIC_KEY); // 0x04||x||y
  const x = bufToB64u(pub.slice(1, 33));
  const y = bufToB64u(pub.slice(33, 65));
  const jwk = { kty: "EC", crv: "P-256", x, y, d: env.VAPID_PRIVATE_KEY, ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = bufToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bufToB64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT
  })));
  const key = await importVapidKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(header + "." + claims)));
  const jwt = header + "." + claims + "." + bufToB64u(sig);
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function sendPush(sub, payloadObj, env) {
  const body = await encryptPayload(sub, JSON.stringify(payloadObj));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": await vapidAuth(sub.endpoint, env),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "1800",
      "Urgency": "normal"
    },
    body
  });
  return res.status;
}

/* ---- HTTP API ---- */
function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
const json = (obj, env, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors(env) } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    if (url.pathname === "/vapidPublicKey" && request.method === "GET")
      return json({ key: env.VAPID_PUBLIC_KEY }, env);

    if (url.pathname === "/subscribe" && request.method === "POST") {
      const data = await request.json().catch(() => null);
      if (!data || !data.subscription || !data.subscription.endpoint) return json({ error: "bad subscription" }, env, 400);
      const id = await sha256Hex(data.subscription.endpoint);
      const rec = {
        endpoint: data.subscription.endpoint,
        keys: data.subscription.keys,
        time: data.time || "21:00",
        tz: data.tz || "Asia/Seoul",
        lastSent: ""
      };
      await env.SUBS.put("sub:" + id, JSON.stringify(rec));
      return json({ ok: true, id }, env);
    }

    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const data = await request.json().catch(() => null);
      if (!data || !data.endpoint) return json({ error: "missing endpoint" }, env, 400);
      await env.SUBS.delete("sub:" + (await sha256Hex(data.endpoint)));
      return json({ ok: true }, env);
    }

    if (url.pathname === "/") return new Response("Daily Log push worker is running.", { headers: cors(env) });
    return new Response("Not found", { status: 404, headers: cors(env) });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  }
};

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  let hh = p.hour === "24" ? "00" : p.hour;
  return { hhmm: hh.padStart(2, "0") + ":" + p.minute, date: `${p.year}-${p.month}-${p.day}` };
}

async function runReminders(env) {
  const now = new Date();
  const list = await env.SUBS.list({ prefix: "sub:" });
  await Promise.all(list.keys.map(async (k) => {
    const raw = await env.SUBS.get(k.name);
    if (!raw) return;
    let sub; try { sub = JSON.parse(raw); } catch { return; }
    const { hhmm, date } = localParts(now, sub.tz || "Asia/Seoul");
    if (sub.time !== hhmm || sub.lastSent === date) return;

    const payload = {
      title: "오늘 로그를 기록할 시간이에요 ✍️",
      body: "아침·회사·저녁 그리고 KPT 회고까지.",
      url: "./?src=push"
    };
    let status = 0;
    try { status = await sendPush(sub, payload, env); } catch { status = 0; }

    if (status === 404 || status === 410) {
      await env.SUBS.delete(k.name);            // subscription expired → clean up
    } else if (status >= 200 && status < 300) {
      sub.lastSent = date;                       // mark sent so we don't repeat today
      await env.SUBS.put(k.name, JSON.stringify(sub));
    }
  }));
}
