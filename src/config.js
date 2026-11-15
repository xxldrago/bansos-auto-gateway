export function loadConfig() {
  const env = process.env;
  const bansosBase = (env.BANSOS_BASE_URL || "http://127.0.0.1:17070").trim();
  const port = Number(env.AUTO_GATEWAY_PORT || env.PORT || 17071);
  return {
    bansosBase,
    port: Number.isFinite(port) && port > 0 ? port : 17071,
    host: env.AUTO_GATEWAY_HOST || "127.0.0.1",
    minContext: Number(env.MIN_CONTEXT || 200000),
    pingIntervalMs: Number(env.PING_INTERVAL_MS || 60 * 60 * 1000),
    pingTimeoutMs: Number(env.PING_TIMEOUT_MS || 12000),
    pingMaxTokens: Number(env.PING_MAX_TOKENS || 8),
    pingConcurrency: Number(env.PING_CONCURRENCY || 4),
    maxRetries: Number(env.MAX_RETRIES || 3),
    cooldownDefaultMs: Number(env.COOLDOWN_MS || 60000),
    cooldownRefusedMs: Number(env.COOLDOWN_REFUSED_MS || 30 * 60000),
    cooldownMaxMs: Number(env.COOLDOWN_MAX_MS || 15 * 60000),
    requireTools: env.REQUIRE_TOOLS === "1",
    excludedSources: (env.EXCLUDED_SOURCES || "zen,llm7")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    authToken: env.AUTO_GATEWAY_TOKEN || "bansos",
  };
}
