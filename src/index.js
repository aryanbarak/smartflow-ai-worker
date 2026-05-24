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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function handleAnalyze(request, env) {
  const cors = corsHeaders(request);

  const origin = request.headers.get("Origin");
  if (origin !== ALLOWED_ORIGIN) {
    return json({ error: "Forbidden origin" }, 403, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }

  const { message, history = [], mode, language } = body;

  if (!message || typeof message !== "string" || !message.trim()) {
    return json({ error: "message is required and must be a non-empty string" }, 400, cors);
  }

  if (!env.GEMINI_API_KEY) {
    return json({ error: "GEMINI_API_KEY is not configured" }, 500, cors);
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
    return json({ error: "Failed to reach Gemini API", detail: String(err) }, 502, cors);
  }

  if (!geminiResponse.ok) {
    const detail = await geminiResponse.text().catch(() => "(unreadable)");
    return json({ error: "Gemini API error", status: geminiResponse.status, detail }, 502, cors);
  }

  const geminiData = await geminiResponse.json();
  const answer = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  return json({ answer }, 200, cors);
}

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

async function handleSearch(request, url) {
  const cors = corsHeaders(request);
  const q = url.searchParams.get("q");
  if (!q) return json({ error: "q is required" }, 400, cors);

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
    return json({ error: "Search unavailable", detail: String(err) }, 503, cors);
  }

  if (!ytResponse.ok) {
    return json({ error: "Search unavailable", status: ytResponse.status }, 503, cors);
  }

  const data = await ytResponse.json();
  const results = parseInnertubeResults(data);

  if (results.length === 0) {
    return json({ error: "No results found" }, 503, cors);
  }

  return json({ results }, 200, cors);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "dailyflow-ai-worker" }, 200, corsHeaders(request));
    }

    if (url.pathname === "/analyze" && request.method === "POST") {
      return handleAnalyze(request, env);
    }

    if (url.pathname === "/search" && request.method === "GET") {
      return handleSearch(request, url);
    }

    return json({ error: "Not found" }, 404, corsHeaders(request));
  },
};
