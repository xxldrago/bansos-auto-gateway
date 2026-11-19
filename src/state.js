import { eligibleModels, fetchModels, pingAll, ensureBansos } from "./bansos.js";

const PREFERRED_TIERS = [
  [
    // kilo models (work reliably, no client IP requirement)
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3.5-super-vl:free",
    "particle-ai/particle-1:free",
    "baidu/ernie-5.5-flash-preview:free",
    "inclusionai/ling-3.2-flash:free",
    // ovh models work reliably
    "ovh/Qwen3.5-397B-A17B",
    "ovh/gpt-oss-120b",
  ],
  [
    "ovh/Meta-Llama-3_3-70B-Instruct",
    "ovh/Qwen2.5-VL-72B-Instruct",
    "ovh/Qwen3.8-27B",
    "ovh/Qwen3.6-27B",
    "dots-studio/dots-3-note-preview:free",
  ],
  [
    "ovh/Mistral-Small-3.2-24B-Instruct-2506",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "nvidia/nemotron-3.5-lightning:free",
    "ovh/gpt-oss-20b",
  ],
];

// Vision tiers: models with vision capability (input includes "image")
// Ordered by preference: reasoning + large context first
// Note: zen and llm7 sources are excluded entirely (client IP requirement / daily quota)
const VISION_TIERS = [
  [
    // kilo models with vision (work reliably)
    "nvidia/nemotron-3.5-super-vl:free",
    "particle-ai/particle-1:free",
    "inclusionai/ling-3.2-flash:free",
  ],
  [
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "dots-studio/dots-3-note-preview:free",
    "ovh/Qwen3.5-397B-A17B",
    "ovh/Qwen3.8-27B",
    "ovh/Qwen3.6-27B",
    "ovh/Qwen3.5-9B",
  ],
  [
    "ovh/Qwen2.5-VL-72B-Instruct",
    "openrouter/free",
  ],
];

export function createState(config, log = console) {
  const cooldowns = new Map(); // modelId -> until timestamp
  let rawModels = [];
  let autoCandidates = []; // sorted eligible model objects for auto
  let visionCandidates = []; // sorted vision-capable model objects
  let pingResults = new Map(); // modelId -> {ok, latencyMs, status, checkedAt}
  let autoSelectedId = null;
  let visionSelectedId = null;
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

  function filterVisionModels(models) {
    return models.filter((m) => m.input && m.input.includes("image"));
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
      const elig = eligibleModels(rawModels, minContext, config.requireTools, config.excludedSources);
      const byId = new Map(elig.map((m) => [m.id, m]));

      pingResults = new Map();

      // ---- AUTO selection ----
      let chosenAutoTier = null;
      let autoTierOk = [];
      let autoTierFailed = [];

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
          chosenAutoTier = tier;
          autoTierOk = ok;
          autoTierFailed = failed;
          break;
        }
      }

      if (chosenAutoTier) {
        const okModels = autoTierOk.map((r) => byId.get(r.id)).filter(Boolean);
        const failedModels = autoTierFailed.map((r) => byId.get(r.id)).filter(Boolean);
        autoCandidates = okModels.concat(failedModels);
        autoSelectedId = okModels.length ? okModels[0].id : (autoCandidates.length ? autoCandidates[0].id : null);
        const usable = autoCandidates.find((m) => !isCoolingDown(m.id));
        if (usable) autoSelectedId = usable.id;
      } else {
        // Fallback: ping all eligible models for auto
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
        autoCandidates = okModels.concat(failedModels);
        autoSelectedId = autoCandidates.length ? autoCandidates[0].id : null;
        const usable = autoCandidates.find((m) => !isCoolingDown(m.id));
        if (usable) autoSelectedId = usable.id;
        else if (autoCandidates.length) autoSelectedId = autoCandidates[0].id;
      }

      // ---- VISION selection ----
      let chosenVisionTier = null;
      let visionTierOk = [];
      let visionTierFailed = [];

      for (const tier of VISION_TIERS) {
        const tierModels = tier.map((id) => byId.get(id)).filter(Boolean);
        if (tierModels.length === 0) continue;

        // Ping only models not already pinged for auto
        const toPing = tierModels.filter((m) => !pingResults.has(m.id));
        if (toPing.length > 0) {
          const results = await pingAll({
            base: config.bansosBase,
            modelIds: toPing.map((m) => m.id),
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
        }

        const allResults = tierModels.map((m) => pingResults.get(m.id)).filter(Boolean);
        const ok = allResults.filter((r) => r.ok && !isCoolingDown(r.id));
        const failed = allResults.filter((r) => !r.ok || isCoolingDown(r.id));
        if (ok.length > 0) {
          ok.sort((a, b) => a.latencyMs - b.latencyMs);
          chosenVisionTier = tier;
          visionTierOk = ok;
          visionTierFailed = failed;
          break;
        }
      }

      if (chosenVisionTier) {
        const okModels = visionTierOk.map((r) => byId.get(r.id)).filter(Boolean);
        const failedModels = visionTierFailed.map((r) => byId.get(r.id)).filter(Boolean);
        visionCandidates = okModels.concat(failedModels);
        visionSelectedId = okModels.length ? okModels[0].id : (visionCandidates.length ? visionCandidates[0].id : null);
        const usable = visionCandidates.find((m) => !isCoolingDown(m.id));
        if (usable) visionSelectedId = usable.id;
      } else {
        // Fallback: all vision-capable models from elig
        const visionElig = filterVisionModels(elig);
        const toPing = visionElig.filter((m) => !pingResults.has(m.id));
        if (toPing.length > 0) {
          const results = await pingAll({
            base: config.bansosBase,
            modelIds: toPing.map((m) => m.id),
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
        }
        const allResults = visionElig.map((m) => pingResults.get(m.id)).filter(Boolean);
        const ok = allResults.filter((r) => r.ok && !isCoolingDown(r.id));
        const failed = allResults.filter((r) => !r.ok || isCoolingDown(r.id));
        ok.sort((a, b) => a.latencyMs - b.latencyMs);
        const okModels = ok.map((r) => byId.get(r.id)).filter(Boolean);
        const failedModels = failed.map((r) => byId.get(r.id)).filter(Boolean);
        visionCandidates = okModels.concat(failedModels);
        visionSelectedId = visionCandidates.length ? visionCandidates[0].id : null;
        const usable = visionCandidates.find((m) => !isCoolingDown(m.id));
        if (usable) visionSelectedId = usable.id;
        else if (visionCandidates.length) visionSelectedId = visionCandidates[0].id;
      }

      lastPingAt = Date.now();
      const okCount = [...pingResults.values()].filter((r) => r.ok).length;
      const failedCount = pingResults.size - okCount;
      log.log?.(
        `[auto-gateway] ping: ${okCount} ok, ${failedCount} failed, auto=${autoSelectedId}` +
          (pingResults.get(autoSelectedId)?.latencyMs ? ` (${pingResults.get(autoSelectedId).latencyMs}ms)` : "") +
          `, vision=${visionSelectedId}` +
          (pingResults.get(visionSelectedId)?.latencyMs ? ` (${pingResults.get(visionSelectedId).latencyMs}ms)` : ""),
      );
      return { ok: okCount, failed: failedCount, autoSelectedId, visionSelectedId };
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function shouldRefresh() {
    if (!lastPingAt) return true;
    if (Date.now() - lastPingAt > config.pingIntervalMs) return true;
    if (!autoSelectedId && !visionSelectedId) return true;
    if (autoSelectedId && isCoolingDown(autoSelectedId)) return true;
    if (visionSelectedId && isCoolingDown(visionSelectedId)) return true;
    return false;
  }

  async function getBest(forceRefresh = false, modelType = "auto") {
    if (forceRefresh || shouldRefresh()) {
      await refresh(forceRefresh);
    }
    if (modelType === "vision") {
      if (visionSelectedId && !isCoolingDown(visionSelectedId)) return visionSelectedId;
      const usable = visionCandidates.find((m) => !isCoolingDown(m.id));
      if (usable) {
        visionSelectedId = usable.id;
        return visionSelectedId;
      }
      await refresh(true);
      if (visionSelectedId) return visionSelectedId;
      return visionCandidates.length ? visionCandidates[0].id : null;
    }
    // auto
    if (autoSelectedId && !isCoolingDown(autoSelectedId)) return autoSelectedId;
    const usable = autoCandidates.find((m) => !isCoolingDown(m.id));
    if (usable) {
      autoSelectedId = usable.id;
      return autoSelectedId;
    }
    await refresh(true);
    if (autoSelectedId) return autoSelectedId;
    return autoCandidates.length ? autoCandidates[0].id : null;
  }

  function snapshot() {
    return {
      autoSelectedId,
      visionSelectedId,
      autoCandidateIds: autoCandidates.map((m) => m.id),
      visionCandidateIds: visionCandidates.map((m) => m.id),
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
    get autoCandidates() {
      return autoCandidates;
    },
    get visionCandidates() {
      return visionCandidates;
    },
    get autoSelectedId() {
      return autoSelectedId;
    },
    get visionSelectedId() {
      return visionSelectedId;
    },
  };
}