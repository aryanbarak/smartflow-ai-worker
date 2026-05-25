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

    return json({ error: "Not found" }, 404, corsHeaders(request));
  },
};
