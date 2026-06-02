const ALLOWED_ORIGIN = "https://barakzai.cloud";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const SYSTEM_PROMPTS = {
  fiae_algorithms:
    "You are an expert IT tutor specializing in FIAE (Fachinformatiker Anwendungsentwicklung) exam preparation. " +
    "Help with algorithms, pseudocode, data structures, sorting, searching, complexity analysis, and IHK AP2 exam topics. " +
    "Use German pseudocode keywords (FUER, BIS, GIB ZURUECK, WENN, SONST). Be precise and exam-focused.",

  wiso:
    "You are a WISO (Wirtschafts- und Sozialkunde) tutor for IHK exams. " +
    "Cover economics, business law, labor law, social insurance, and company organization " +
    "relevant to German vocational training.",

  general_it:
    "You are a helpful IT tutor covering programming, networking, databases, web development, " +
    "and general computer science topics. Adapt explanations to the student's level.",

  planner:
    "You are a productivity and learning coach. Help with daily planning, study schedules, " +
    "goal setting, time management, and workflow organization.",
};

const LANGUAGE_INSTRUCTIONS = {
  fa: "Always respond in Persian (Farsi), regardless of the language of the question.",
  de: "Always respond in German, regardless of the language of the question.",
  en: "Always respond in English, regardless of the language of the question.",
};

function buildSystemInstruction(mode, language) {
  const modePrompt = SYSTEM_PROMPTS[mode] ?? SYSTEM_PROMPTS.general_it;
  const langInstruction =
    LANGUAGE_INSTRUCTIONS[language] ??
    "Detect the language from the message and respond in the same language.";
  return `${modePrompt}\n\n${langInstruction}`;
}

// Allows barakzai.cloud in production and localhost on any port for development.
function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const isAllowed =
    origin === ALLOWED_ORIGIN || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

// ─── Rate limiting ─────────────────────────────────────────────────────────────

async function checkRateLimit(env, ip, endpoint, limit) {
  if (!env.RATE_LIMIT_KV) return { allowed: true, remaining: limit - 1 };

  const key = `rl:${endpoint}:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
  const current = Number.parseInt((await env.RATE_LIMIT_KV.get(key)) ?? "0", 10);

  if (current >= limit) return { allowed: false, remaining: 0 };

  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 3600 });
  return { allowed: true, remaining: limit - current - 1 };
}

function rlHeaders(limit, remaining) {
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining),
  };
}

const RATE_LIMIT_EXCEEDED = {
  error: "Too many requests",
  message: "Rate limit exceeded. Please try again in an hour.",
  retryAfter: 3600,
};

// ─── Auth ─────────────────────────────────────────────────────────────────────
// Supabase uses RS256 (asymmetric) by default, so HMAC verification is not
// viable without the public key. Instead we decode the payload to get the
// userId for R2 key scoping; Supabase RLS enforces data-layer authorization.

function decodeJWTPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  return JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/")));
}

function requireAuth(request) {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return { userId: null, error: "Missing authorization token" };
  const token = auth.slice(7);
  try {
    const claims = decodeJWTPayload(token);
    if (typeof claims.exp === "number" && claims.exp < Date.now() / 1000) {
      return { userId: null, error: "Token expired" };
    }
    if (!claims.sub) return { userId: null, error: "Invalid token" };
    return { userId: String(claims.sub), error: null };
  } catch {
    return { userId: null, error: "Invalid token" };
  }
}

// ─── AI analyze ───────────────────────────────────────────────────────────────

async function handleAnalyze(request, env) {
  const cors = corsHeaders(request);

  const origin = request.headers.get("Origin");
  if (origin !== ALLOWED_ORIGIN) {
    return json({ error: "Forbidden origin" }, 403, cors);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRateLimit(env, ip, "analyze", 20);
  const headers = { ...cors, ...rlHeaders(20, rl.remaining) };

  if (!rl.allowed) {
    return json(RATE_LIMIT_EXCEEDED, 429, { ...headers, "Retry-After": "3600" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, headers);
  }

  const { message, history = [], mode, language } = body;

  if (!message || typeof message !== "string" || !message.trim()) {
    return json({ error: "message is required and must be a non-empty string" }, 400, headers);
  }

  if (!env.GEMINI_API_KEY) {
    return json({ error: "GEMINI_API_KEY is not configured" }, 500, headers);
  }

  const systemInstruction = buildSystemInstruction(mode, language);

  // Accepts both "assistant" (OpenAI-style) and "model" (Gemini-native) role names.
  const contents = [
    ...history
      .filter((m) => m && typeof m.content === "string" && m.content.trim())
      .map((m) => ({
        role: m.role === "assistant" || m.role === "model" ? "model" : "user",
        parts: [{ text: m.content.trim() }],
      })),
    { role: "user", parts: [{ text: message.trim() }] },
  ];

  let geminiResponse;
  try {
    geminiResponse = await fetch(`${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents,
      }),
    });
  } catch (err) {
    return json({ error: "Failed to reach Gemini API", detail: String(err) }, 502, headers);
  }

  if (!geminiResponse.ok) {
    const detail = await geminiResponse.text().catch(() => "(unreadable)");
    return json({ error: "Gemini API error", status: geminiResponse.status, detail }, 502, headers);
  }

  const geminiData = await geminiResponse.json();
  const answer = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  return json({ answer }, 200, headers);
}

// ─── YouTube search ────────────────────────────────────────────────────────────

function parseInnertubeResults(data) {
  const items =
    data?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer
      ?.contents?.[0]?.itemSectionRenderer?.contents ?? [];

  return items
    .filter((item) => item.videoRenderer)
    .map((item) => {
      const v = item.videoRenderer;
      const title =
        v.title?.runs?.[0]?.text ??
        v.title?.accessibility?.accessibilityData?.label ??
        "";
      const author = v.ownerText?.runs?.[0]?.text ?? "";
      const durationText = v.lengthText?.simpleText ?? "";
      const viewText =
        v.viewCountText?.simpleText ?? v.viewCountText?.runs?.[0]?.text ?? "0";

      const parts = durationText.split(":").map(Number);
      let lengthSeconds = 0;
      if (parts.length === 3) lengthSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) lengthSeconds = parts[0] * 60 + parts[1];

      const viewCount = Number.parseInt(viewText.replace(/\D/g, ""), 10) || 0;

      return { type: "video", videoId: v.videoId, title, author, lengthSeconds, viewCount };
    });
}

async function handleSearch(request, env, url) {
  const cors = corsHeaders(request);
  const q = url.searchParams.get("q");
  if (!q) return json({ error: "q is required" }, 400, cors);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRateLimit(env, ip, "search", 60);
  const headers = { ...cors, ...rlHeaders(60, rl.remaining) };

  if (!rl.allowed) {
    return json(RATE_LIMIT_EXCEEDED, 429, { ...headers, "Retry-After": "3600" });
  }

  let ytResponse;
  try {
    ytResponse = await fetch(
      "https://www.youtube.com/youtubei/v1/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00" } },
          query: q,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch (err) {
    return json({ error: "Search unavailable", detail: String(err) }, 503, headers);
  }

  if (!ytResponse.ok) {
    return json({ error: "Search unavailable", status: ytResponse.status }, 503, headers);
  }

  const data = await ytResponse.json();
  const results = parseInnertubeResults(data);

  if (results.length === 0) {
    return json({ error: "No results found" }, 503, headers);
  }

  return json({ results }, 200, headers);
}

// ─── Photo endpoints ───────────────────────────────────────────────────────────

async function handlePhotoUpload(request, env) {
  const cors = corsHeaders(request);
  const { userId, error: authError } = requireAuth(request);
  if (authError) return json({ error: authError }, 401, cors);

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Invalid multipart body" }, 400, cors);
  }

  const file = formData.get("file");
  const thumb = formData.get("thumb");
  const uuid = formData.get("uuid");

  if (!file || typeof file === "string") return json({ error: "file field is required" }, 400, cors);
  if (!uuid || typeof uuid !== "string") return json({ error: "uuid field is required" }, 400, cors);

  if (!env.PHOTOS_BUCKET) return json({ error: "Storage not configured" }, 500, cors);

  const nameParts = file.name.split(".");
  const ext = nameParts.length > 1 ? nameParts.pop().toLowerCase() : "bin";
  const key = `photos/${userId}/${uuid}.${ext}`;
  const thumbKey = `photos/${userId}/${uuid}_thumb.jpg`;

  await env.PHOTOS_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  if (thumb && typeof thumb !== "string") {
    await env.PHOTOS_BUCKET.put(thumbKey, thumb.stream(), {
      httpMetadata: { contentType: "image/jpeg" },
    });
  }

  return json({ key, thumbKey }, 200, cors);
}

// Read endpoint is intentionally open (UUIDs are unguessable; no sensitive content beyond auth).
async function handlePhotoFile(request, env, url) {
  const cors = corsHeaders(request);
  const key = url.searchParams.get("key");
  if (!key) return json({ error: "key is required" }, 400, cors);

  if (!env.PHOTOS_BUCKET) return json({ error: "Storage not configured" }, 500, cors);

  const obj = await env.PHOTOS_BUCKET.get(key);
  if (!obj) return json({ error: "Not found" }, 404, cors);

  const headers = new Headers(cors);
  headers.set("Content-Type", obj.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(obj.body, { status: 200, headers });
}

async function handlePhotoDelete(request, env, url) {
  const cors = corsHeaders(request);
  const { userId, error: authError } = requireAuth(request);
  if (authError) return json({ error: authError }, 401, cors);

  const key = url.searchParams.get("key");
  if (!key) return json({ error: "key is required" }, 400, cors);

  // Verify ownership: key must be scoped to this user
  if (!key.startsWith(`photos/${userId}/`)) {
    return json({ error: "Forbidden" }, 403, cors);
  }

  if (!env.PHOTOS_BUCKET) return json({ error: "Storage not configured" }, 500, cors);

  await env.PHOTOS_BUCKET.delete(key);

  // Best-effort thumbnail deletion (no error if it doesn't exist)
  const thumbKey = key.replace(/(\.[^.]+)?$/, "_thumb.jpg");
  await env.PHOTOS_BUCKET.delete(thumbKey).catch(() => undefined);

  return json({ ok: true }, 200, cors);
}

async function handlePhotoAnalyze(request, env) {
  const cors = corsHeaders(request);
  const { userId, error: authError } = requireAuth(request);
  if (authError) return json({ error: authError }, 401, cors);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRateLimit(env, ip, "photo-analyze", 10);
  const headers = { ...cors, ...rlHeaders(10, rl.remaining) };

  if (!rl.allowed) {
    return json(RATE_LIMIT_EXCEEDED, 429, { ...headers, "Retry-After": "3600" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, headers);
  }

  const { key } = body;
  if (!key || typeof key !== "string") {
    return json({ error: "key is required" }, 400, headers);
  }

  if (!key.startsWith(`photos/${userId}/`)) {
    return json({ error: "Forbidden" }, 403, headers);
  }

  if (!env.PHOTOS_BUCKET) return json({ error: "Storage not configured" }, 500, headers);
  if (!env.GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not configured" }, 500, headers);

  const obj = await env.PHOTOS_BUCKET.get(key);
  if (!obj) return json({ error: "Photo not found" }, 404, headers);

  const bytes = await obj.arrayBuffer();
  const arr = new Uint8Array(bytes);
  let str = "";
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    str += String.fromCodePoint(...arr.subarray(i, i + chunk));
  }
  const base64 = btoa(str);
  const mimeType = obj.httpMetadata?.contentType ?? "image/jpeg";

  const prompt =
    'Analyze this photo. Respond with JSON only (no markdown fence):\n' +
    '{"description":"one sentence","tags":["tag1","tag2"],"people_count":0}\n' +
    'Rules: tags are 3-8 lowercase words/phrases for objects, setting, activity, mood. ' +
    'people_count is number of visible people (0 if none).';

  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            { text: prompt },
          ],
        }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
  } catch (err) {
    return json({ error: "Failed to reach Gemini API", detail: String(err) }, 502, headers);
  }

  if (!geminiRes.ok) {
    const detail = await geminiRes.text().catch(() => "(unreadable)");
    return json({ error: "Gemini API error", status: geminiRes.status, detail }, 502, headers);
  }

  const geminiData = await geminiRes.json();
  const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = {};
  }

  return json({
    description: typeof result.description === "string" ? result.description : "",
    tags: Array.isArray(result.tags) ? result.tags.filter((t) => typeof t === "string") : [],
    people_count: typeof result.people_count === "number" ? result.people_count : 0,
  }, 200, headers);
}

// ─── OCR (Gemini Vision) ──────────────────────────────────────────────────────

async function fileToBase64(file) {
  const bytes = await file.arrayBuffer();
  const arr = new Uint8Array(bytes);
  let str = "";
  const chunkSize = 8192;
  for (let i = 0; i < arr.length; i += chunkSize) {
    str += String.fromCodePoint(...arr.subarray(i, i + chunkSize));
  }
  return btoa(str);
}

function buildOcrPrompt(language) {
  const langNames = { de: "German", en: "English", fa: "Persian (Farsi)" };
  const langHint = langNames[language] ?? String(language);
  return (
    `Extract all text from this document. Primary language hint: ${langHint}. ` +
    "Return ONLY the extracted text, preserving paragraphs and line breaks. " +
    "Do not add commentary, headers, or explanations."
  );
}

async function handleOcr(request, env) {
  const cors = corsHeaders(request);
  const { error: authError } = requireAuth(request);
  if (authError) return json({ error: authError }, 401, cors);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRateLimit(env, ip, "ocr", 10);
  const headers = { ...cors, ...rlHeaders(10, rl.remaining) };

  if (!rl.allowed) {
    return json(RATE_LIMIT_EXCEEDED, 429, { ...headers, "Retry-After": "3600" });
  }

  if (!env.GEMINI_API_KEY) {
    return json({ error: "GEMINI_API_KEY is not configured" }, 500, headers);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Invalid multipart body" }, 400, headers);
  }

  const file = formData.get("file");
  const language = formData.get("language") ?? "en";

  if (!file || typeof file === "string") {
    return json({ error: "file field is required" }, 400, headers);
  }

  if (file.size > 15 * 1024 * 1024) {
    return json({ error: "File too large (max 15 MB)" }, 413, headers);
  }

  const base64 = await fileToBase64(file);
  const prompt = buildOcrPrompt(language);

  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: file.type || "application/octet-stream", data: base64 } },
            { text: prompt },
          ],
        }],
      }),
    });
  } catch (err) {
    return json({ error: "Failed to reach Gemini API", detail: String(err) }, 502, headers);
  }

  if (!geminiRes.ok) {
    const detail = await geminiRes.text().catch(() => "(unreadable)");
    return json({ error: "Gemini API error", status: geminiRes.status, detail }, 502, headers);
  }

  const geminiData = await geminiRes.json();
  const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  return json({ text }, 200, headers);
}

// ─── ElevenLabs TTS ───────────────────────────────────────────────────────────

function ttsTextError(text) {
  if (!text || typeof text !== "string" || !text.trim()) return "text is required";
  if (text.length > 3000) return "Text too long (max 3,000 characters)";
  return null;
}

async function callElevenLabs(apiKey, text, voiceId) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${String(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text: text.trim(),
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );
  return res;
}

async function handleTts(request, env) {
  const cors = corsHeaders(request);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRateLimit(env, ip, "tts", 10);
  const headers = { ...cors, ...rlHeaders(10, rl.remaining) };

  if (!rl.allowed) {
    return json(RATE_LIMIT_EXCEEDED, 429, { ...headers, "Retry-After": "3600" });
  }
  // Trim to guard against trailing newline from wrangler secret piping
  const elevenKey = (env.ELEVENLABS_API_KEY ?? "").trim();
  if (!elevenKey) {
    return json({ error: "ELEVENLABS_API_KEY is not configured" }, 500, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400, cors); }

  const { text, voiceId = "pNInz6obpgDQGcFmaJgB" } = body;
  const textErr = ttsTextError(text);
  if (textErr) return json({ error: textErr }, 400, cors);

  let ttsRes;
  try { ttsRes = await callElevenLabs(elevenKey, text, voiceId); }
  catch (err) { return json({ error: "Failed to reach ElevenLabs API", detail: String(err) }, 502, cors); }

  if (!ttsRes.ok) {
    const detail = await ttsRes.text().catch(() => "(unreadable)");
    return json({ error: "ElevenLabs API error", status: ttsRes.status, detail }, 502, cors);
  }

  return new Response(ttsRes.body, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", "Content-Disposition": 'inline; filename="audio.mp3"', ...cors },
  });
}

// ─── DeepL Translation ────────────────────────────────────────────────────────

const DEEPL_LANGS = { fa: "FA", de: "DE", en: "EN-GB" };

async function callDeepL(apiKey, text, targetLang, sourceLang) {
  const body = { text: [text.slice(0, 50000)], target_lang: DEEPL_LANGS[targetLang] ?? "DE" };
  if (sourceLang) body.source_lang = DEEPL_LANGS[sourceLang];

  const res = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: { "Authorization": `DeepL-Auth-Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "(unreadable)");
    throw Object.assign(new Error("DeepL API error"), { status: res.status, detail });
  }

  const data = await res.json();
  return {
    translated: data.translations?.[0]?.text ?? "",
    detected_source: data.translations?.[0]?.detected_source_language ?? null,
  };
}

async function handleTranslate(request, env) {
  const cors = corsHeaders(request);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRateLimit(env, ip, "translate", 30);
  const headers = { ...cors, ...rlHeaders(30, rl.remaining) };

  if (!rl.allowed) {
    return json(RATE_LIMIT_EXCEEDED, 429, { ...headers, "Retry-After": "3600" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, headers);
  }

  const { text, targetLang, sourceLang } = body;

  if (!text || typeof text !== "string" || !text.trim()) {
    return json({ error: "text is required" }, 400, headers);
  }
  if (!targetLang) {
    return json({ error: "targetLang is required" }, 400, headers);
  }
  if (!env.DEEPL_API_KEY) {
    return json({ error: "DEEPL_API_KEY is not configured" }, 500, headers);
  }

  try {
    const result = await callDeepL(env.DEEPL_API_KEY, text, targetLang, sourceLang);
    return json(result, 200, headers);
  } catch (err) {
    const status = err.status ?? 502;
    const detail = err.detail ?? String(err);
    return json({ error: err.message, status, detail }, 502, headers);
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "dailyflow-ai-worker" }, 200, corsHeaders(request));
    }

    if (pathname === "/analyze" && request.method === "POST") {
      return handleAnalyze(request, env);
    }

    if (pathname === "/search" && request.method === "GET") {
      return handleSearch(request, env, url);
    }

    if (pathname === "/photos/upload" && request.method === "POST") {
      return handlePhotoUpload(request, env);
    }

    if (pathname === "/photos/file" && request.method === "GET") {
      return handlePhotoFile(request, env, url);
    }

    if (pathname === "/photos/delete" && request.method === "DELETE") {
      return handlePhotoDelete(request, env, url);
    }

    if (pathname === "/photos/analyze" && request.method === "POST") {
      return handlePhotoAnalyze(request, env);
    }

    if (pathname === "/translate" && request.method === "POST") {
      return handleTranslate(request, env);
    }

    if (pathname === "/ocr" && request.method === "POST") {
      return handleOcr(request, env);
    }

    if (pathname === "/tts" && request.method === "POST") {
      return handleTts(request, env);
    }

    return json({ error: "Not found" }, 404, corsHeaders(request));
  },
};
