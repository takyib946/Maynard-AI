// api/chat.mjs: Vercel serverless function using the Groq API.
// Keeps your Groq API key on the server. Set these in Vercel → Settings → Environment Variables:
//   GROQ_API_KEY       (required) your key, starts with gsk_
//   GROQ_MODEL         (optional) text model, default llama-3.3-70b-versatile
//   GROQ_VISION_MODEL  (optional) used when a message has an image, default meta-llama/llama-4-scout-17b-16e-instruct

export const config = { maxDuration: 60 };

const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const TEXT_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_TOKENS = 2048;
const MAX_MESSAGES = 60;
const MAX_IMAGES = 5; // Groq allows at most 5 images per request

function fail(res, status, message) {
  res.status(status).json({ error: { message } });
}

// Convert the page's message format into the OpenAI-style format Groq expects.
function convert(messages, system) {
  const out = [];
  if (typeof system === "string" && system) out.push({ role: "system", content: system.slice(0, 4000) });

  // Keep only the newest MAX_IMAGES images; older ones become a text note.
  let imageBudget = MAX_IMAGES;
  const imageAllowed = new Map();
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = Array.isArray(messages[i].content) ? messages[i].content : [];
    const flags = [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      if (blocks[j] && blocks[j].type === "image") flags[j] = imageBudget-- > 0;
    }
    imageAllowed.set(i, flags);
  }

  let hasImage = false;
  messages.forEach((m, i) => {
    const role = m.role === "assistant" ? "assistant" : "user";
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    const parts = [];
    blocks.forEach((b, j) => {
      if (!b) return;
      if (b.type === "text" && b.text) {
        parts.push({ type: "text", text: String(b.text) });
      } else if (b.type === "image" && b.source && b.source.type === "base64" && /^image\//.test(b.source.media_type || "")) {
        if (imageAllowed.get(i)[j]) {
          hasImage = true;
          parts.push({ type: "image_url", image_url: { url: "data:" + b.source.media_type + ";base64," + b.source.data } });
        } else {
          parts.push({ type: "text", text: "[An earlier image is no longer available.]" });
        }
      }
    });
    if (!parts.length) return;
    // Images only appear in user messages; plain text is sent as a simple string.
    const textOnly = parts.every((p) => p.type === "text");
    out.push({ role, content: textOnly ? parts.map((p) => p.text).join("\n") : parts });
  });

  return { out, hasImage };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "Use POST.");
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return fail(res, 500, "The server is missing GROQ_API_KEY.");

  const { messages, system } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return fail(res, 400, "Send a non-empty messages array (max " + MAX_MESSAGES + ").");
  }

  const { out, hasImage } = convert(messages, system);
  if (!out.some((m) => m.role === "user")) return fail(res, 400, "No usable message content.");

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
        authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: hasImage ? VISION_MODEL : TEXT_MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: out,
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

  // Translate Groq's stream into the event format the page already understands.
  const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(payload); } catch (e) { continue; }
        if (evt.error) { send({ type: "error", error: { message: evt.error.message || "Stream error" } }); continue; }
        const text = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
        if (text) send({ type: "content_block_delta", delta: { type: "text_delta", text } });
      }
    }
  } catch (err) {
    // client left or the stream broke; nothing more to send
  }
  res.end();
                  }
