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
  const langInstruction = LANGUAGE_INSTRUCTIONS[language] ?? "Detect the language from the message and respond in the same language.";
  return `${modePrompt}\n\n${langInstruction}`;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Health check — no auth required
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "dailyflow-ai-worker" }, 200, corsHeaders(request));
    }

    // POST /analyze
    if (url.pathname === "/analyze" && request.method === "POST") {
      // Enforce origin
      const origin = request.headers.get("Origin");
      if (origin !== ALLOWED_ORIGIN) {
        return json({ error: "Forbidden origin" }, 403, corsHeaders(request));
      }

      // Parse request body
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400, corsHeaders(request));
      }

      const { message, history = [], mode, language } = body;

      if (!message || typeof message !== "string" || !message.trim()) {
        return json(
          { error: "message is required and must be a non-empty string" },
          400,
          corsHeaders(request),
        );
      }

      if (!env.GEMINI_API_KEY) {
        return json({ error: "GEMINI_API_KEY is not configured" }, 500, corsHeaders(request));
      }

      // Build system instruction from mode + language
      const systemInstruction = buildSystemInstruction(mode, language);

      // Map history from {role, content} → Gemini {role, parts}
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

      // Forward to Gemini with system instruction
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
        return json(
          { error: "Failed to reach Gemini API", detail: String(err) },
          502,
          corsHeaders(request),
        );
      }

      if (!geminiResponse.ok) {
        const detail = await geminiResponse.text().catch(() => "(unreadable)");
        return json(
          { error: "Gemini API error", status: geminiResponse.status, detail },
          502,
          corsHeaders(request),
        );
      }

      const geminiData = await geminiResponse.json();
      const answer = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      return json({ answer }, 200, corsHeaders(request));
    }

    return json({ error: "Not found" }, 404, corsHeaders(request));
  },
};
