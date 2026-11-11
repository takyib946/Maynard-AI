// api/chat.mjs: Vercel serverless function. Keeps your Anthropic API key on the server.
// Set ANTHROPIC_API_KEY (required) and ANTHROPIC_MODEL (optional) in Vercel → Settings → Environment Variables.

export const config = { maxDuration: 60 };

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = 2048;
const MAX_MESSAGES = 60;

function fail(res, status, message) {
  res.status(status).json({ error: { message } });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "Use POST.");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail(res, 500, "The server is missing ANTHROPIC_API_KEY.");

  const { messages, system } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return fail(res, 400, "Send a non-empty messages array (max " + MAX_MESSAGES + ").");
  }

  // The model and token limit are fixed here so visitors can't pick expensive settings.
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: typeof system === "string" ? system.slice(0, 4000) : undefined,
        messages,
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    return fail(res, 502, "Could not reach the AI service.");
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    res.status(upstream.status).setHeader("content-type", "application/json");
    return res.end(text);
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (err) {
    // client left or the stream broke; nothing more to send
  }
  res.end();
}
