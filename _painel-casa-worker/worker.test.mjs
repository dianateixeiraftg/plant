// Teste do Worker com respostas simuladas (não contacta a Fox ESS nem a Shelly).
// Correr com: node worker.test.mjs
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import worker from "./worker.js";

// O Node não tem MD5 no WebCrypto (o Cloudflare Workers tem); aqui usamos o módulo crypto.
const subtle = globalThis.crypto.subtle;
const orig = subtle.digest.bind(subtle);
subtle.digest = (alg, data) =>
  alg === "MD5" ? Promise.resolve(createHash("md5").update(Buffer.from(data)).digest().buffer) : orig(alg, data);

const env = {
  PIN: "pin-de-teste-longo",
  FOX_API_KEY: "chave-fox-secreta",
  FOX_SN: "SN123",
  SHELLY_AUTH_KEY: "chave-shelly-secreta",
  SHELLY_HOST: "shelly-1-eu.shelly.cloud",
  SHELLY_DEVICES: JSON.stringify([
    { id: "aaa111", name: "Luz sala", channel: 0 },
    { id: "bbb222", name: "Gen1 tomada", channel: 0 },
  ]),
  ALLOWED_ORIGIN: "https://exemplo.github.io",
};

const calls = [];
let foxBody = { errno: 0, result: [{ deviceSN: "SN123", datas: [
  { variable: "pvPower", unit: "kW", value: 2.5, time: "t" },
  { variable: "SoC", unit: "%", value: 80, time: "t" },
] }] };
let shellyBody = [
  { id: "aaa111", online: 1, status: { "switch:0": { output: true, apower: 42.5 } } },
  { id: "bbb222", online: 0, status: { relays: [{ ison: false }], meters: [{ power: 0 }] } },
];
let shellySetStatus = 200;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  if (String(url).startsWith("https://www.foxesscloud.com")) return new Response(JSON.stringify(foxBody));
  if (String(url).includes("/v2/devices/api/get")) return new Response(JSON.stringify(shellyBody));
  if (String(url).includes("/v2/devices/api/set/switch")) {
    return shellySetStatus === 200 ? new Response("") : new Response(JSON.stringify({ error: "DEVICE_OFFLINE" }), { status: shellySetStatus });
  }
  throw new Error("pedido inesperado: " + url);
};

const req = (path, { method = "GET", pin = env.PIN, body, origin } = {}) =>
  new Request("https://w.example" + path, {
    method,
    headers: { ...(pin ? { "X-Pin": pin } : {}), ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
const run = async (r) => { const res = await worker.fetch(r, env); return { res, json: await res.json().catch(() => null) }; };

// 1. Sem PIN ou com PIN errado: 401 e nenhuma chamada aos serviços
{
  let r = await run(req("/api/fox", { pin: "" }));
  assert.equal(r.res.status, 401);
  r = await run(req("/api/fox", { pin: "errado" }));
  assert.equal(r.res.status, 401);
  assert.equal(calls.length, 0);
}

// 2. Fox ESS: assinatura, cabeçalhos, corpo e resposta
{
  const before = Date.now();
  const { res, json } = await run(req("/api/fox"));
  assert.equal(res.status, 200);
  const c = calls.at(-1);
  assert.equal(c.url, "https://www.foxesscloud.com/op/v1/device/real/query");
  const h = c.init.headers;
  assert.equal(h.token, env.FOX_API_KEY);
  assert.ok(Number(h.timestamp) >= before);
  const expected = createHash("md5").update("/op/v1/device/real/query\\r\\n" + env.FOX_API_KEY + "\\r\\n" + h.timestamp).digest("hex");
  assert.equal(h.signature, expected, "assinatura com \\r\\n literais");
  assert.deepEqual(JSON.parse(c.init.body).sns, ["SN123"]);
  assert.equal(json.values.pvPower.value, 2.5);
  assert.equal(json.values.SoC.unit, "%");
}

// 3. Fox ESS: erros do serviço viram mensagens claras
{
  foxBody = { errno: 40400, msg: "limit" };
  let r = await run(req("/api/fox"));
  assert.equal(r.res.status, 429);
  foxBody = { errno: 41930, msg: "token" };
  r = await run(req("/api/fox"));
  assert.equal(r.res.status, 502);
  assert.ok(!JSON.stringify(r.json).includes(env.FOX_API_KEY));
}

// 4. Shelly: leitura de Gen2 (switch:0) e Gen1 (relays/meters), chave só no URL do pedido
{
  const { res, json } = await run(req("/api/shelly"));
  assert.equal(res.status, 200);
  const c = calls.at(-1);
  assert.ok(c.url.startsWith("https://shelly-1-eu.shelly.cloud/v2/devices/api/get?auth_key="));
  assert.deepEqual(JSON.parse(c.init.body), { ids: ["aaa111", "bbb222"], select: ["status"] });
  assert.deepEqual(json.devices[0], { id: "aaa111", name: "Luz sala", channel: 0, online: true, output: true, power: 42.5 });
  assert.deepEqual(json.devices[1], { id: "bbb222", name: "Gen1 tomada", channel: 0, online: false, output: false, power: 0 });
  assert.ok(!JSON.stringify(json).includes(env.SHELLY_AUTH_KEY));
}

// 5. Shelly: comando só para dispositivos configurados
{
  let r = await run(req("/api/shelly/switch", { method: "POST", body: { id: "intruso", channel: 0, on: true } }));
  assert.equal(r.res.status, 400);
  r = await run(req("/api/shelly/switch", { method: "POST", body: { id: "aaa111", channel: 0, on: "sim" } }));
  assert.equal(r.res.status, 400);
  const n = calls.length;
  r = await run(req("/api/shelly/switch", { method: "POST", body: { id: "aaa111", channel: 0, on: false } }));
  assert.equal(r.res.status, 200);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { id: "aaa111", channel: 0, on: false });
  assert.equal(calls.length, n + 1);
  shellySetStatus = 400;
  r = await run(req("/api/shelly/switch", { method: "POST", body: { id: "aaa111", channel: 0, on: true } }));
  assert.equal(r.res.status, 409);
  assert.equal(r.json.error, "Shelly: DEVICE_OFFLINE");
}

// 6. Servidor Shelly inválido é recusado (evita pedidos a outros sítios)
{
  const bad = { ...env, SHELLY_HOST: "evil.example.com" };
  const res = await worker.fetch(req("/api/shelly"), bad);
  assert.equal(res.status, 500);
}

// 7. CORS: só o endereço do site
{
  let { res } = await run(req("/api/fox", { origin: "https://exemplo.github.io" }));
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://exemplo.github.io");
  ({ res } = await run(req("/api/fox", { origin: "https://outro.site" })));
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  const pre = await worker.fetch(new Request("https://w.example/api/fox", { method: "OPTIONS", headers: { Origin: "https://exemplo.github.io" } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Headers"), "X-Pin, Content-Type");
}

console.log("Todos os testes passaram.");
