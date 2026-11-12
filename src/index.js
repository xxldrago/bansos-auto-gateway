#!/usr/bin/env node
import http from "node:http";
import { loadConfig } from "./config.js";
import { bansosUrls, ensureBansos } from "./bansos.js";
import { createState } from "./state.js";

const config = loadConfig();
const log = console;
const state = createState(config, log);
const urls = bansosUrls(config.bansosBase);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "access-control-allow-origin": "*",
  });
  res.end(data);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("request aborted")));
  });
}

function buildHeaders(req, forceNoFailover) {
  const headers = {
    "content-type": "application/json",
    authorization: req.headers.authorization || `Bearer ${config.authToken}`,
  };
  if (forceNoFailover) headers["x-bansos-no-failover"] = "1";
  if (req.headers.accept) headers.accept = req.headers.accept;
  return headers;
}

async function proxyOnce(bodyObj, req, res, forceNoFailover) {
  const controller = new AbortController();
  const onClientClose = () => {
    if (!res.writableFinished) controller.abort();
  };
  req.on("aborted", () => controller.abort());
  res.on("close", onClientClose);

  let upstreamRes;
  try {
    upstreamRes = await fetch(urls.chat, {
      method: "POST",
      headers: buildHeaders(req, forceNoFailover),
      body: JSON.stringify(bodyObj),
      signal: controller.signal,
    });
  } catch (err) {
    res.off("close", onClientClose);
    return { ok: false, status: 502, error: err?.message || "upstream request failed", response: null };
  }

  res.off("close", onClientClose);
  return { ok: true, status: upstreamRes.status, response: upstreamRes };
}

async function pipeResponse(res, upstreamRes, requestedModel) {
  const contentType = upstreamRes.headers.get("content-type") || "application/json";
  const isStream = contentType.includes("text/event-stream");
  const isJson = contentType.includes("application/json");

  if (isStream) {
    res.writeHead(upstreamRes.status, {
      "content-type": contentType,
      "cache-control": upstreamRes.headers.get("cache-control") || "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch {
        // client gone or upstream interrupted
      }
    }
    res.end();
    return;
  }

  const text = await upstreamRes.text();
  if (isJson && requestedModel === "auto") {
    try {
      const json = JSON.parse(text);
      if (json && typeof json === "object") json.model = "auto";
      const out = JSON.stringify(json);
      res.writeHead(upstreamRes.status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(out),
        "access-control-allow-origin": "*",
      });
      res.end(out);
      return;
    } catch {
      // fall through
    }
  }
  res.writeHead(upstreamRes.status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": "*",
  });
  res.end(text);
}

async function handleChat(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: { message: err.message } });
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: { message: "invalid JSON body" } });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, { error: { message: "request body must be a JSON object" } });
    return;
  }

  const requestedModel = body.model;

  // Non-auto requests are passed through unchanged.
  if (requestedModel !== "auto") {
    const upstreamRes = await fetch(urls.chat, {
      method: "POST",
      headers: buildHeaders(req, req.headers["x-bansos-no-failover"] === "1"),
      body: raw,
    }).catch((err) => ({ __error: err }));
    if (upstreamRes && upstreamRes.__error) {
      sendJson(res, 502, { error: { message: upstreamRes.__error.message || "upstream request failed" } });
      return;
    }
    await pipeResponse(res, upstreamRes, requestedModel);
    return;
  }

  const tried = new Set();
  let lastStatus = 502;
  let lastError = "no upstream candidates left";
  let attempts = 0;

  while (attempts < config.maxRetries) {
    attempts += 1;
    const forceRefresh = attempts > 1;
    const best = await state.getBest(forceRefresh);
    if (!best) {
      lastStatus = 503;
      lastError = "no eligible models (context >= minContext and reasoning)";
      break;
    }
    if (tried.has(best)) {
      // All viable candidates have been tried; stop retrying.
      if (tried.size >= Math.max(1, state.candidates.length)) break;
      // Force a fresh ping and try again.
      await state.refresh(true);
      continue;
    }
    tried.add(best);

    const upstreamBody = { ...body, model: best };
    const result = await proxyOnce(upstreamBody, req, res, true);
    if (!result.ok) {
      lastStatus = result.status;
      lastError = result.error;
      state.markCooldown(best, config.cooldownDefaultMs);
      continue;
    }
    const upstreamRes = result.response;
    if (upstreamRes.status >= 400) {
      const text = await upstreamRes.text().catch(() => "");
      lastStatus = upstreamRes.status;
      try {
        const json = JSON.parse(text);
        lastError = json?.error?.message || json?.message || text.slice(0, 256) || lastError;
      } catch {
        lastError = text.slice(0, 256) || lastError;
      }
      // cooldown based on status
      if (upstreamRes.status === 401 || upstreamRes.status === 403) state.markRefused(best);
      else if (upstreamRes.status === 429) state.markRateLimited(best, null);
      else state.markCooldown(best, config.cooldownDefaultMs);
      continue;
    }

    // success
    state.cooldowns.delete(best);
    await pipeResponse(res, upstreamRes, "auto");
    return;
  }

  sendJson(res, lastStatus || 502, {
    error: { message: lastError, type: "auto_gateway_error" },
  });
}

function handleModels(req, res) {
  const raw = state.rawModels || [];
  const autoModel = {
    id: "auto",
    object: "model",
    created: 0,
    owned_by: "bansos-auto",
    source: "auto",
    name: "Auto (lowest ping: reasoning + context >= 200k)",
    context_window: raw.length
      ? Math.max(...raw.map((m) => Number(m.context_window ?? m.context_length ?? 0)))
      : config.minContext,
    context_length: raw.length
      ? Math.max(...raw.map((m) => Number(m.context_window ?? m.context_length ?? 0)))
      : config.minContext,
    max_tokens: 0,
    maxTokens: 0,
    reasoning: true,
    input: ["text"],
    supports_tools: true,
  };
  const data = [autoModel, ...raw];
  sendJson(res, 200, { object: "list", data });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    status: "ok",
    bansosBase: urls.base,
    bansosOk: state.rawModels.length > 0 || true,
    selected: state.selectedId,
    candidates: state.candidates.map((m) => m.id),
    lastPingAt: state.snapshot().lastPingAt,
    cooldowns: state.snapshot().cooldowns,
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-bansos-no-failover",
    });
    res.end();
    return;
  }

  if (method === "GET" && (url === "/healthz" || url === "/health")) {
    handleHealth(req, res);
    return;
  }
  if (method === "GET" && (url === "/v1/models" || url === "/models")) {
    handleModels(req, res);
    return;
  }
  if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
    await handleChat(req, res);
    return;
  }

  sendJson(res, 404, { error: { message: "not found" } });
});

// Start bansos and initial refresh in background.
ensureBansos(config.bansosBase, log)
  .then(() => state.refresh(false))
  .then(() => {
    log.log?.(`[auto-gateway] initial refresh done; selected=${state.selectedId}`);
  })
  .catch((err) => log.error?.("[auto-gateway] initial refresh failed:", err?.message || err));

// Hourly re-ping.
const interval = setInterval(() => {
  state.refresh(true).catch((err) => log.error?.("[auto-gateway] refresh failed:", err?.message || err));
}, config.pingIntervalMs);
interval.unref();

server.listen(config.port, config.host, () => {
  log.log?.(`[auto-gateway] listening on http://${config.host}:${config.port}`);
  log.log?.(`[auto-gateway] bansos base: ${urls.base}`);
  log.log?.(`[auto-gateway] minContext=${config.minContext}, pingInterval=${config.pingIntervalMs}ms`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
