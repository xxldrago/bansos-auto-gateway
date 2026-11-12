import { eligibleModels, fetchModels, pingAll, ensureBansos } from "./bansos.js";

const PREFERRED_TIERS = [
  [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "ovh/Qwen3.5-397B-A17B",
    "nvidia/nemotron-3.5-super-vl:free",
    "particle-ai/particle-1:free",
    "ovh/gpt-oss-120b",
  ],
  [
    "ovh/Meta-Llama-3_3-70B-Instruct",
    "ovh/Qwen2.5-VL-72B-Instruct",
    "baidu/ernie-5.5-flash-preview:free",
    "ovh/Qwen3.8-27B",
    "ovh/Qwen3.6-27B",
    "dots-studio/dots-3-note-preview:free",
  ],
  [
    "ovh/Mistral-Small-3.2-24B-Instruct-2506",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "codestral-latest",
    "mistral-Nemo-Instruct-2407",
    "nvidia/nemotron-3.5-lightning:free",
    "ovh/gpt-oss-20b",
  ],
];

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
      const byId = new Map(elig.map((m) => [m.id, m]));

      pingResults = new Map();
      let chosenTier = null;
      let tierOk = [];
      let tierFailed = [];

      // Preferred tiers first: ping only the current tier; if at least one model
      // is available, pick the one with the best ping from that tier.
      for (const tier of PREFERRED_TIERS) {
        const tierModels = tier.map((id) => byId.get(id)).filter(Boolean);
        if (tierModels.length === 0) continue;

        const results = await pingAll({
          base: config.bansosBase,
          modelIds: tierModels.map((m) => m.id),
          authToken: config.authToken,
          timeoutMs: config.pingTimeoutMs,
          maxTokens: config.pingMaxTokens,
          concurrency: config.pingConcurrency,
        });

        for (const r of results) {
          pingResults.set(r.id, { ...r, checkedAt: Date.now() });
          if (r.ok) cooldowns.delete(r.id);
          else {
            if (r.status === 401 || r.status === 403) markRefused(r.id);
            else if (r.status === 429) markRateLimited(r.id, null);
            else markCooldown(r.id, classifyFailure(r.status, r.message));
          }
        }

        const ok = results.filter((r) => r.ok && !isCoolingDown(r.id));
        const failed = results.filter((r) => !r.ok || isCoolingDown(r.id));
        if (ok.length > 0) {
          ok.sort((a, b) => a.latencyMs - b.latencyMs);
          chosenTier = tier;
          tierOk = ok;
          tierFailed = failed;
          break;
        }
      }

      if (chosenTier) {
        const okModels = tierOk.map((r) => byId.get(r.id)).filter(Boolean);
        const failedModels = tierFailed.map((r) => byId.get(r.id)).filter(Boolean);
        candidates = okModels.concat(failedModels);
        selectedId = okModels.length ? okModels[0].id : (candidates.length ? candidates[0].id : null);
        const usable = candidates.find((m) => !isCoolingDown(m.id));
        if (usable) selectedId = usable.id;
      } else {
        // Fallback: none of the preferred tiers is available.
        // Ping all eligible models and pick by best ping, as before.
        const ids = elig.map((m) => m.id);
        const results = await pingAll({
          base: config.bansosBase,
          modelIds: ids,
          authToken: config.authToken,
          timeoutMs: config.pingTimeoutMs,
          maxTokens: config.pingMaxTokens,
          concurrency: config.pingConcurrency,
        });

        const ok = [];
        const failed = [];
        for (const r of results) {
          pingResults.set(r.id, { ...r, checkedAt: Date.now() });
          if (r.ok) cooldowns.delete(r.id);
          else {
            if (r.status === 401 || r.status === 403) markRefused(r.id);
            else if (r.status === 429) markRateLimited(r.id, null);
            else markCooldown(r.id, classifyFailure(r.status, r.message));
          }
          if (r.ok && !isCoolingDown(r.id)) ok.push(r);
          else failed.push(r);
        }

        ok.sort((a, b) => a.latencyMs - b.latencyMs);
        const okModels = ok.map((r) => byId.get(r.id)).filter(Boolean);
        const failedModels = failed.map((r) => byId.get(r.id)).filter(Boolean);
        candidates = okModels.concat(failedModels);
        selectedId = candidates.length ? candidates[0].id : null;
        const usable = candidates.find((m) => !isCoolingDown(m.id));
        if (usable) selectedId = usable.id;
        else if (candidates.length) selectedId = candidates[0].id;
      }

      lastPingAt = Date.now();
      const okCount = [...pingResults.values()].filter((r) => r.ok).length;
      const failedCount = pingResults.size - okCount;
      log.log?.(
        `[auto-gateway] ping: ${okCount} ok, ${failedCount} failed, selected=${selectedId}` +
          (pingResults.get(selectedId)?.latencyMs ? ` (${pingResults.get(selectedId).latencyMs}ms)` : ""),
      );
      return { ok: okCount, failed: failedCount, selectedId };
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
