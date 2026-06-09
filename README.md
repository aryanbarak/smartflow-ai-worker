<div align="center">

# dailyflow-ai-worker

**Cloudflare Worker — secure AI proxy for DailyFlow**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Gemini](https://img.shields.io/badge/Google-Gemini_AI-4285F4?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev/)
[![License](https://img.shields.io/badge/License-All_Rights_Reserved-red?style=for-the-badge)]()

</div>

---

## Overview

This worker connects the [DailyFlow](https://github.com/aryanbarak/dailyflow) frontend with Google Gemini AI. It acts as a secure serverless proxy — handling authentication, CORS, rate limiting and Gemini API communication so the API key is never exposed in the browser.

**Live app:** https://barakzai.cloud · **Main repo:** [aryanbarak/dailyflow](https://github.com/aryanbarak/dailyflow)

---

## Endpoints

| Method | Path | Protection | Description |
|--------|------|------------|-------------|
| `POST` | `/analyze` | JWT + Origin | Send a message to Gemini, returns AI response |
| `POST` | `/briefing` | JWT + Origin | Generate personalized weekly life briefing |
| `POST` | `/translate` | JWT + Origin | Translate text via Gemini |
| `POST` | `/tts` | JWT + Origin | Text-to-speech conversion |
| `GET` | `/health` | Public | Health check |

---

## Request / Response

**Request**
```json
{
  "message": "Explain database normalization in simple terms",
  "conversation": []
}
```

**Response**
```json
{
  "answer": "Database normalization is a way to organize data..."
}
```

---

## Security

The Gemini API key is never exposed to the browser. All requests go through this worker which enforces:

| Measure | Implementation |
|---------|----------------|
| API key isolation | Stored in Cloudflare Worker secrets only |
| User authentication | JWT validation on every protected endpoint |
| Rate limiting | Per-user request counter via Cloudflare KV |
| Origin restriction | CORS whitelist for DailyFlow frontend only |

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Cloudflare Workers (V8 isolates) |
| Language | JavaScript (ES2022) |
| AI | Google Gemini 2.5 Flash → 2.0 Flash (fallback) |
| Rate limiting | Cloudflare KV |
| Auth | JWT validation |
| Deploy | Wrangler CLI |

---

## Deployment

```bash
# Install Wrangler
npm install -g wrangler

# Authenticate
wrangler login

# Set Gemini API key as secret
wrangler secret put GEMINI_API_KEY

# Deploy
wrangler deploy
```

---

## Powers these DailyFlow features

- AI Learning Assistant
- Weekly Life Briefing
- Document Analysis & OCR Summaries
- Action Item Generation
- Text-to-Speech

---

## Author

**Aryan Barakzai** · [barakzai.cloud](https://barakzai.cloud) · [GitHub](https://github.com/aryanbarak)

---

## License

All Rights Reserved — Copyright © Aryan Barakzai
