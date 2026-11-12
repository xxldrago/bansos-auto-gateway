import { spawn } from "node:child_process";

export function normalizeBase(raw) {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  if (!u) u = "http://127.0.0.1:17070";
  if (!/\/v1$/i.test(u)) u += "/v1";
  return u;
}

export function bansosUrls(base) {
  const b = normalizeBase(base);
  return {
    base: b,
    health: b.replace(/\/v1$/, "") + "/healthz",
    models: b + "/models",
    chat: b + "/chat/completions",
  };
}

export async function healthCheck(base, timeoutMs = 1500) {
  const { health } = bansosUrls(base);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(health, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function ensureBansos(base, log = console) {
  if (await healthCheck(base, 1000)) return true;
  try {
    const child = spawn("bansos", ["start", "--bg"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    log.log?.("[auto-gateway] started bansos daemon");
  } catch (err) {
    log.error?.("[auto-gateway] failed to spawn bansos:", err?.message || err);
    return false;
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await healthCheck(base, 1000)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function fetchModels(base, timeoutMs = 5000) {
  const { models } = bansosUrls(base);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(models, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function eligibleModels(models, minContext, requireTools) {
  return (models || []).filter((m) => {
    const ctx = Number(m.context_window ?? m.context_length ?? 0);
    if (m.reasoning !== true) return false;
    if (!Number.isFinite(ctx) || ctx < minContext) return false;
    if (requireTools && m.supports_tools === false) return false;
    return true;
  });
}

export async function pingModel({ base, modelId, authToken, timeoutMs, maxTokens }) {
  const { chat } = bansosUrls(base);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(chat, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        "x-bansos-no-failover": "1",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    const text = await res.text().catch(() => "");
    if (res.ok) {
      return { id: modelId, ok: true, status: res.status, latencyMs };
    }
    let detail = `HTTP ${res.status}`;
    try {
      const json = JSON.parse(text);
      if (json?.error?.message) detail = String(json.error.message).slice(0, 80);
    } catch {}
    return { id: modelId, ok: false, status: res.status, latencyMs, message: detail };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err?.name === "AbortError" ? "timeout" : (err?.message || "unreachable");
    return { id: modelId, ok: false, status: "ERR", latencyMs, message };
  } finally {
    clearTimeout(timer);
  }
}

export async function pingAll({ base, modelIds, authToken, timeoutMs, maxTokens, concurrency }) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < modelIds.length) {
      const idx = i++;
      const id = modelIds[idx];
      const r = await pingModel({ base, modelId: id, authToken, timeoutMs, maxTokens });
      results[idx] = r;
    }
  });
  await Promise.all(workers);
  return results;
}
