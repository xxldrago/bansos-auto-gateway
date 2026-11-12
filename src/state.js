import { eligibleModels, fetchModels, pingAll, ensureBansos } from "./bansos.js";

export function createState(config, log = console) {
  const cooldowns = new Map(); // modelId -> until timestamp
  let rawModels = [];
  let candidates = []; // sorted eligible model objects from bansos
  let pingResults = new Map(); // modelId -> {ok, latencyMs, status, checkedAt}
  let selectedId = null;
  let lastDiscoveryAt = 0;
  let lastPingAt = 0;
  let refreshPromise = null;
  const minContext = config.minContext;

  function isCoolingDown(id, now = Date.now()) {
    const until = cooldowns.get(id);
    if (until === undefined) return false;
    if (until <= now) {
      cooldowns.delete(id);
      return false;
    }
    return true;
  }

  function markCooldown(id, ms) {
    const capped = Math.min(Math.max(ms || config.cooldownDefaultMs, 1000), config.cooldownMaxMs);
    cooldowns.set(id, Date.now() + capped);
  }

  function markRefused(id) {
    cooldowns.set(id, Date.now() + config.cooldownRefusedMs);
  }

  function markRateLimited(id, retryAfterMs) {
    markCooldown(id, retryAfterMs || config.cooldownDefaultMs);
  }

  function classifyFailure(status, message = "") {
    if (status === 429) return config.cooldownDefaultMs;
    if (status === 401 || status === 403) return config.cooldownRefusedMs;
    if (status === "ERR") return config.cooldownDefaultMs;
    return config.cooldownDefaultMs;
  }

  async function refresh(force = false) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      await ensureBansos(config.bansosBase, log);
      const models = await fetchModels(config.bansosBase);
      if (models) {
        rawModels = models;
        lastDiscoveryAt = Date.now();
      }
      const elig = eligibleModels(rawModels, minContext, config.requireTools);
      const ids = elig.map((m) => m.id);

      // Ping all eligible models. On forced refresh (after a failure) this is the
      // "повторный пинг" requested by the user.
      const results = await pingAll({
        base: config.bansosBase,
        modelIds: ids,
        authToken: config.authToken,
        timeoutMs: config.pingTimeoutMs,
        maxTokens: config.pingMaxTokens,
        concurrency: config.pingConcurrency,
      });

      pingResults = new Map();
      const ok = [];
      const failed = [];
      for (const r of results) {
        pingResults.set(r.id, { ...r, checkedAt: Date.now() });
        if (r.ok && !isCoolingDown(r.id)) ok.push(r);
        else failed.push(r);
      }
      // cooldown bookkeeping from ping results
      for (const r of results) {
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) markRefused(r.id);
          else if (r.status === 429) markRateLimited(r.id, null);
          else markCooldown(r.id, classifyFailure(r.status, r.message));
        } else {
          // successful ping clears cooldown
          cooldowns.delete(r.id);
        }
      }

      ok.sort((a, b) => a.latencyMs - b.latencyMs);
      candidates = ok.map((r) => elig.find((m) => m.id === r.id)).filter(Boolean);
      // keep failed-but-eligible as fallback candidates in original order
      const failedModels = failed.map((r) => elig.find((m) => m.id === r.id)).filter(Boolean);
      // Append failed models after ok ones so they can be tried if nothing else.
      candidates = candidates.concat(failedModels);

      selectedId = candidates.length ? candidates[0].id : null;
      // skip cooling-down selected
      const usable = candidates.find((m) => !isCoolingDown(m.id));
      if (usable) selectedId = usable.id;
      else if (candidates.length) selectedId = candidates[0].id;

      lastPingAt = Date.now();
      log.log?.(
        `[auto-gateway] ping: ${ok.length} ok, ${failed.length} failed, selected=${selectedId}` +
          (ok[0] ? ` (${ok[0].latencyMs}ms)` : ""),
      );
      return { ok: ok.length, failed: failed.length, selectedId };
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function shouldRefresh() {
    if (!lastPingAt) return true;
    if (Date.now() - lastPingAt > config.pingIntervalMs) return true;
    if (!selectedId) return true;
    if (isCoolingDown(selectedId)) return true;
    return false;
  }

  async function getBest(forceRefresh = false) {
    if (forceRefresh || shouldRefresh()) {
      await refresh(forceRefresh);
    }
    if (selectedId && !isCoolingDown(selectedId)) return selectedId;
    // try to find any non-cooling candidate without a full refresh first
    const usable = candidates.find((m) => !isCoolingDown(m.id));
    if (usable) {
      selectedId = usable.id;
      return selectedId;
    }
    // all cooling: force a refresh (re-ping) and accept best available
    await refresh(true);
    if (selectedId) return selectedId;
    return candidates.length ? candidates[0].id : null;
  }

  function snapshot() {
    return {
      selectedId,
      candidateIds: candidates.map((m) => m.id),
      rawModelCount: rawModels.length,
      lastDiscoveryAt,
      lastPingAt,
      cooldowns: Object.fromEntries(cooldowns),
      pingResults: Object.fromEntries(pingResults),
    };
  }

  return {
    cooldowns,
    isCoolingDown,
    markCooldown,
    markRefused,
    markRateLimited,
    classifyFailure,
    refresh,
    getBest,
    snapshot,
    get rawModels() {
      return rawModels;
    },
    get candidates() {
      return candidates;
    },
    get selectedId() {
      return selectedId;
    },
  };
}
