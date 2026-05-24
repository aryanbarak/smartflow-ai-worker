const ALLOWED_ORIGIN = "https://barakzai.cloud";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

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

      const { message, history = [] } = body;

      if (!message || typeof message !== "string" || !message.trim()) {
        return json({ error: "message is required and must be a non-empty string" }, 400, corsHeaders(request));
      }

      if (!env.GEMINI_API_KEY) {
        return json({ error: "GEMINI_API_KEY is not configured" }, 500, corsHeaders(request));
      }

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

      // Forward to Gemini
      let geminiResponse;
      try {
        geminiResponse = await fetch(`${GEMINI_ENDPOINT}?key=${env.GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents }),
        });
      } catch (err) {
        return json({ error: "Failed to reach Gemini API", detail: String(err) }, 502, corsHeaders(request));
      }

      if (!geminiResponse.ok) {
        const detail = await geminiResponse.text().catch(() => "(unreadable)");
        return json(
          { error: "Gemini API error", status: geminiResponse.status, detail },
          502,
          corsHeaders(request)
        );
      }

      const geminiData = await geminiResponse.json();
      const answer = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      return json({ answer }, 200, corsHeaders(request));
    }

    return json({ error: "Not found" }, 404, corsHeaders(request));
  },
};
