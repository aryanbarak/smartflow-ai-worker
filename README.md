# dailyflow-ai-worker

Cloudflare Worker API for connecting the DailyFlow frontend with Google Gemini AI.

This worker acts as a secure proxy between the frontend application and the Gemini API.  
It handles CORS, receives AI requests from `barakzai.cloud`, forwards the conversation to Gemini 2.5 Flash and returns a structured answer to the frontend.

## Features

- Secure API proxy for Gemini AI
- CORS protection for `https://barakzai.cloud`
- `/analyze` endpoint for AI requests
- `/health` endpoint for availability checks
- JSON-based request and response handling
- Deployed as a Cloudflare Worker

## Tech Stack

- JavaScript
- Cloudflare Workers
- Google Gemini API
- REST API
- CORS

## Endpoints

| Method | Path | Auth / Protection | Description |
|---|---|---|---|
| `POST` | `/analyze` | Origin check | Sends a message to Gemini and returns an AI response |
| `GET` | `/health` | None | Health check endpoint |
## Request Example

```json
{
  "message": "Explain normalization in databases",
  "conversation": []
}
```

## Response Example

```json
{
  "answer": "Normalization is a database design process..."
}
```

## Related Project

This worker is used by the DailyFlow web application:

https://barakzai.cloud