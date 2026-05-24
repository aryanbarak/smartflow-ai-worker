# dailyflow-ai-worker

Cloudflare Worker that proxies requests from the dailyFlow frontend to the Google Gemini API.

## What it does

- Receives `POST /analyze` requests from `https://barakzai.cloud`
- Enforces CORS — only requests from `https://barakzai.cloud` are accepted
- Forwards the message + conversation history to Gemini 2.5 Flash
- Returns `{ answer: string }` to the frontend

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/analyze` | Origin check | Send message, get AI answer |
| `GET` | `/health` | None | Health check |

### Request body (`POST /analyze`)

```json
{
  "message": "What is a binary search tree?",
  "history": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi! How can I help?" }
  ]
}
```

### Response

```json
{ "answer": "A binary search tree is..." }
```

## Deploy

```bash
npm install
npx wrangler deploy
```

## Required secrets

Set the Gemini API key as a Cloudflare Worker secret (never commit it):

```bash
npx wrangler secret put GEMINI_API_KEY
```

## Route

The Worker is bound to:

```
api.barakzai.cloud/analyze
```

Configured in `wrangler.toml`:

```toml
[[routes]]
pattern = "api.barakzai.cloud/analyze"
zone_name = "barakzai.cloud"
```

## Local development

```bash
npx wrangler dev
```

Note: CORS is locked to `https://barakzai.cloud` in production. During local dev the Worker runs on `localhost:8787`.
