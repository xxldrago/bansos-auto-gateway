# Cloudflare Worker для Telegram Bot Proxy

Этот Cloudflare Worker проксирует запросы к Telegram Bot API, позволяя запускать `opencode-telegram-bot` локально даже при ограниченном сетевом доступе.

## Развёртывание

### 1. Установите Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Авторизуйтесь в Cloudflare

```bash
wrangler login
```

### 3. Задеплойте Worker

```bash
wrangler deploy
```

После деплоя Worker будет доступен по адресу:
```
https://telegram-proxy.<your-subdomain>.workers.dev
```

### 4. Настройте opencode-telegram-bot

Создайте или обновите `.env` файл:

```bash
TELEGRAM_BOT_TOKEN=9132746823:AAHrOAqP9i_gQKPBffzxOHYQwdRNPcyGk7Q
TELEGRAM_ALLOWED_USER_ID=902227074
OPENCODE_API_URL=http://127.0.0.1:49374
OPENCODE_SERVER_VERSION=v2
OPENCODE_SERVER_PASSWORD=<your-password>
BOT_LOCALE=ru
TELEGRAM_API_BASE_URL=https://telegram-proxy.<your-subdomain>.workers.dev/api
```

### 5. Запустите бота

```bash
opencode-telegram start
```

## Маршруты

- `GET /health` — проверка работоспособности
- `POST /api/:method/*` — проксирование запросов к Telegram Bot API

## Примеры

Проверка бота:
```bash
curl https://telegram-proxy.<your-subdomain>.workers.dev/api/getMe
```

Получение обновлений:
```bash
curl https://telegram-proxy.<your-subdomain>.workers.dev/api/getUpdates
```

## Лицензия

MIT
