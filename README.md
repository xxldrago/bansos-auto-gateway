# bansos-auto-gateway

Надстройка над `bansos-router` (v0.6.3+): выдаёт виртуальные модели `auto` и `vision`, которые автоматически пингуют подходящие модели bansos и выбирают лучшую по пингу.

## Запуск

```bash
cd /Users/alekseimikhalkin/Documents/bansos-router
npm start
```

По умолчанию слушает `127.0.0.1:17071` и использует bansos на `127.0.0.1:17070`. Если bansos не запущен, надстройка поднимает его сама (`bansos start --bg`).

## Модели

### `auto` — лучшая reasoning-модель (context ≥ 200k)

Приоритетная логика выбора (по tiers, внутри tier — по минимальному пингу):

**Tier 1 (проверяются первыми):**
1. `nvidia/nemotron-3-ultra-550b-a55b:free`
2. `nvidia/nemotron-3.5-super-vl:free`
3. `particle-ai/particle-1:free`
4. `baidu/ernie-5.5-flash-preview:free`
5. `inclusionai/ling-3.2-flash:free`
6. `ovh/Qwen3.5-397B-A17B`
7. `ovh/gpt-oss-120b`

**Tier 2 (если Tier 1 недоступен):**
1. `ovh/Meta-Llama-3_3-70B-Instruct`
2. `ovh/Qwen2.5-VL-72B-Instruct`
3. `ovh/Qwen3.8-27B`
4. `ovh/Qwen3.6-27B`
5. `dots-studio/dots-3-note-preview:free`

**Tier 3 (если Tier 2 недоступен):**
1. `ovh/Mistral-Small-3.2-24B-Instruct-2506`
2. `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
3. `nvidia/nemotron-3.5-lightning:free`
4. `ovh/gpt-oss-20b`

**Fallback:** если ни один tier недоступен, пингуются все подходящие модели (кроме `zen` и `llm7`) с context ≥ 200k и выбирается лучшая по пингу.

### `vision` — лучшая vision-модель (поддержка изображений + reasoning + context ≥ 200k)

**Tier 1:**
1. `nvidia/nemotron-3.5-super-vl:free`
2. `particle-ai/particle-1:free`
3. `inclusionai/ling-3.2-flash:free`

**Tier 2:**
1. `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
2. `dots-studio/dots-3-note-preview:free`
3. `ovh/Qwen3.5-397B-A17B`
4. `ovh/Qwen3.8-27B`
5. `ovh/Qwen3.6-27B`
6. `ovh/Qwen3.5-9B`

**Tier 3:**
1. `ovh/Qwen2.5-VL-72B-Instruct`
2. `openrouter/free`

**Fallback:** все vision-модели с reasoning и context ≥ 200k (кроме `zen` и `llm7`).

## Конфигурация Hermes

`~/.hermes/config.yaml`:

```yaml
model:
  provider: custom
  default: auto
  base_url: http://127.0.0.1:17071/v1
```

Для vision-модели можно использовать `default: vision` или переключаться вручную.

## OpenCode

Модели добавлены в `~/.config/opencode/opencode.json` и `opencode.jsonc`:

```json
"bansos-auto": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "bansos-auto",
  "options": { "baseURL": "http://127.0.0.1:17071/v1" },
  "models": {
    "auto": { "name": "auto" },
    "vision": { "name": "vision" }
  }
}
```

Доступны как `bansos-auto/auto` и `bansos-auto/vision`.

## Переменные окружения

- `AUTO_GATEWAY_PORT` / `PORT` — порт надстройки (по умолчанию 17071)
- `AUTO_GATEWAY_HOST` — хост (по умолчанию 127.0.0.1)
- `BANSOS_BASE_URL` — базовый URL bansos (по умолчанию http://127.0.0.1:17070)
- `MIN_CONTEXT` — минимальный контекст (по умолчанию 200000)
- `PING_INTERVAL_MS` — интервал фонового пинга (по умолчанию 3600000 = 1 час)
- `PING_TIMEOUT_MS` — таймаут одного пинга (по умолчанию 12000)
- `PING_MAX_TOKENS` — max_tokens для пинга (по умолчанию 8)
- `PING_CONCURRENCY` — параллельность пингов (по умолчанию 4)
- `MAX_RETRIES` — число попыток при недоступности (по умолчанию 3)
- `REQUIRE_TOOLS` — если `1`, дополнительно требовать `supports_tools=true`
- `AUTO_GATEWAY_TOKEN` — bearer token для bansos (по умолчанию bansos)

## Поведение при недоступности

При ошибке/таймауте/429/401/403 выбранной модели надстройка:
1. помечает модель в cooldown;
2. делает повторный пинг всех подходящих моделей в текущем tier;
3. выбирает следующую доступную с минимальным пингом;
4. повторяет тот же запрос с ней.
5. Если tier исчерпан — переходит к следующему tier'у.

Фоновый пинг запускается раз в час (или по `PING_INTERVAL_MS`).

## Стриминг

Стриминг в Hermes/OpenAI API — это ответы по частям (SSE). Для надстройки это важно: если модель упала после того, как первые байты уже ушли клиенту, прозрачно повторить запрос нельзя. Поэтому retry работает надёжно до начала отдачи; при обрыве потока посередине надстройка возвращает ошибку. Если критичен максимально надёжный failover, стриминг лучше отключить.