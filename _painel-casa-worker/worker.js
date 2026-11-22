// Painel da Casa: intermediário (Cloudflare Worker).
// Guarda as chaves da Fox ESS e da Shelly e fala com elas por ti.
// A página só fala com este Worker e tem de enviar o PIN no cabeçalho X-Pin.
//
// Segredos (nunca no código nem no repositório):
//   PIN                 palavra-passe longa que escolhes
//   FOX_API_KEY         chave de API da Fox ESS Cloud
//   FOX_SN              número de série do inversor
//   SHELLY_AUTH_KEY     chave de autorização da Shelly Cloud
//   SHELLY_HOST         servidor da Shelly Cloud (ex.: shelly-XX-eu.shelly.cloud)
//   SHELLY_DEVICES      JSON: [{"id":"...","name":"Luz sala","channel":0}, ...]
// Variável normal:
//   ALLOWED_ORIGIN      endereço do teu site (ex.: https://utilizador.github.io)

const FOX_BASE = "https://www.foxesscloud.com";
const FOX_PATH = "/op/v1/device/real/query";
const FOX_VARS = ["pvPower", "loadsPower", "feedinPower", "gridConsumptionPower", "SoC", "todayYield"];
// A Fox ESS permite 1440 chamadas por dia por inversor (uma por minuto, em média).
const FOX_TTL = 120;
const SHELLY_TTL = 8;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const h = { "Vary": "Origin" };
  if (origin && env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "X-Pin, Content-Type";
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

function reply(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(request, env) },
  });
}

async function digest(alg, text) {
  return new Uint8Array(await crypto.subtle.digest(alg, new TextEncoder().encode(text)));
}
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function pinOk(request, env) {
  const given = request.headers.get("X-Pin") || "";
  if (!env.PIN || !given) return false;
  const [a, b] = await Promise.all([digest("SHA-256", given), digest("SHA-256", env.PIN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function cached(key, ttl, fn) {
  const store = typeof caches !== "undefined" ? caches.default : null;
  const req = new Request("https://cache.painel-casa.invalid/" + key);
  if (store) {
    const hit = await store.match(req);
    if (hit) return hit.json();
  }
  const value = await fn();
  if (store) {
    await store.put(req, new Response(JSON.stringify(value), { headers: { "Cache-Control": "max-age=" + ttl } }));
  }
  return value;
}
async function forget(key) {
  if (typeof caches !== "undefined") await caches.default.delete(new Request("https://cache.painel-casa.invalid/" + key));
}

function scrub(text, env) {
  let t = String(text);
  for (const s of [env.SHELLY_AUTH_KEY, env.FOX_API_KEY, env.PIN]) if (s) t = t.split(s).join("***");
  return t;
}

// ---------- Fox ESS ----------
async function foxReal(env) {
  if (!env.FOX_API_KEY || !env.FOX_SN) throw new HttpError(500, "Fox ESS não configurada no Worker.");
  const timestamp = Date.now().toString();
  // A assinatura usa as sequências \r\n escritas como texto (barra, r, barra, n), não quebras de linha.
  const signature = hex(await digest("MD5", `${FOX_PATH}\\r\\n${env.FOX_API_KEY}\\r\\n${timestamp}`));
  const res = await fetch(FOX_BASE + FOX_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: env.FOX_API_KEY, timestamp, signature, lang: "en" },
    body: JSON.stringify({ sns: [env.FOX_SN], variables: FOX_VARS }),
  });
  if (!res.ok) throw new HttpError(502, "A Fox ESS respondeu com erro HTTP " + res.status + ".");
  const body = await res.json();
  if (body.errno === 40400) throw new HttpError(429, "Limite de chamadas da Fox ESS atingido. Tenta daqui a pouco.");
  if (body.errno !== 0) throw new HttpError(502, "Fox ESS: erro " + body.errno + (body.msg ? " (" + body.msg + ")" : "") + ".");
  const datas = (body.result && body.result[0] && body.result[0].datas) || [];
  const values = {};
  for (const d of datas) values[d.variable] = { value: d.value, unit: d.unit || "", time: d.time || "" };
  return { values, fetchedAt: Date.now() };
}

// ---------- Shelly ----------
function shellyConfig(env) {
  let devices;
  try { devices = JSON.parse(env.SHELLY_DEVICES || "[]"); } catch (e) { devices = null; }
  if (!Array.isArray(devices) || devices.length === 0) throw new HttpError(500, "Shelly sem dispositivos configurados no Worker.");
  if (!env.SHELLY_AUTH_KEY || !/^[a-z0-9.-]+\.shelly\.cloud$/i.test(env.SHELLY_HOST || "")) {
    throw new HttpError(500, "Shelly mal configurada no Worker (chave ou servidor).");
  }
  return devices.map((d) => ({ id: String(d.id), name: String(d.name || d.id), channel: Number(d.channel) || 0 }));
}
function shellyUrl(env, path) {
  return `https://${env.SHELLY_HOST}${path}?auth_key=${encodeURIComponent(env.SHELLY_AUTH_KEY)}`;
}

async function shellyStatus(env) {
  const devices = shellyConfig(env);
  const ids = [...new Set(devices.map((d) => d.id))].slice(0, 10); // a API aceita até 10 por pedido
  const res = await fetch(shellyUrl(env, "/v2/devices/api/get"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, select: ["status"] }),
  });
  if (!res.ok) throw new HttpError(502, "A Shelly Cloud respondeu com erro HTTP " + res.status + ".");
  const body = await res.json();
  const list = Array.isArray(body) ? body : (body && (body.data || body.devices)) || [];
  const byId = {};
  for (const s of list) if (s && s.id != null) byId[String(s.id).toLowerCase()] = s;
  const out = devices.map((d) => {
    const s = byId[d.id.toLowerCase()];
    const st = (s && s.status) || {};
    const sw = st["switch:" + d.channel];
    let output = null, power = null;
    if (sw) { output = typeof sw.output === "boolean" ? sw.output : null; power = typeof sw.apower === "number" ? sw.apower : null; }
    else {
      if (st.relays && st.relays[d.channel]) output = !!st.relays[d.channel].ison;      // Gen1
      if (st.meters && st.meters[d.channel]) power = Number(st.meters[d.channel].power); // Gen1
    }
    return { id: d.id, name: d.name, channel: d.channel, online: !!(s && (s.online === 1 || s.online === true)), output, power };
  });
  return { devices: out, fetchedAt: Date.now() };
}

async function shellySwitch(env, request) {
  const devices = shellyConfig(env);
  let input;
  try { input = await request.json(); } catch (e) { throw new HttpError(400, "Corpo do pedido inválido."); }
  const channel = Number(input.channel) || 0;
  const known = devices.find((d) => d.id === String(input.id) && d.channel === channel);
  if (!known || typeof input.on !== "boolean") throw new HttpError(400, "Dispositivo ou estado inválido.");
  const res = await fetch(shellyUrl(env, "/v2/devices/api/set/switch"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: known.id, channel, on: input.on }),
  });
  if (!res.ok) {
    let msg = "A Shelly Cloud recusou o comando (HTTP " + res.status + ").";
    try { const b = await res.json(); if (b && b.error) msg = "Shelly: " + b.error; } catch (e) {}
    throw new HttpError(res.status === 400 ? 409 : 502, msg);
  }
  await forget("shelly");
  return { ok: true };
}

// ---------- entrada ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    if (!(await pinOk(request, env))) {
      await new Promise((r) => setTimeout(r, 800)); // trava tentativas rápidas de adivinhar o PIN
      return reply({ error: "PIN em falta ou errado." }, 401, request, env);
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/fox") return reply(await cached("fox", FOX_TTL, () => foxReal(env)), 200, request, env);
      if (request.method === "GET" && url.pathname === "/api/shelly") return reply(await cached("shelly", SHELLY_TTL, () => shellyStatus(env)), 200, request, env);
      if (request.method === "POST" && url.pathname === "/api/shelly/switch") return reply(await shellySwitch(env, request), 200, request, env);
      return reply({ error: "Não encontrado." }, 404, request, env);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      const message = e instanceof HttpError ? e.message : "Falha ao contactar o serviço.";
      return reply({ error: scrub(message, env) }, status, request, env);
    }
  },
};
