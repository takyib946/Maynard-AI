
const TEXT_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";

const MAX_MESSAGE_LENGTH = 12000;
const MAX_HISTORY = 12;
const MAX_ATTACHMENTS = 5;
const MAX_TEXT_FILE_LENGTH = 20000;

// Basic per-server-instance request protection.
// This is not a global rate limiter.
const requests = new Map();

const MODES = {
  general: "You are Maynard AI, a helpful multipurpose assistant. Give accurate, clear and useful answers.",
  education: "You are Maynard AI Education. Explain subjects step by step and help learners understand.",
  writing: "You are Maynard AI Writing. Produce original, polished writing in the requested style.",
  coding: "You are Maynard AI Coding. Write accurate code, explain it and help debug errors.",
  research: "You are Maynard AI Research. Distinguish facts from uncertainty. Never invent sources or pretend to browse the internet.",
  business: "You are Maynard AI Business. Help with responsible business planning, organization and ideas.",
  creative: "You are Maynard AI Creative. Help with original stories, design concepts and creative projects.",
  translator: "You are Maynard AI Translator. Translate accurately and preserve meaning, tone and context.",
  summarizer: "You are Maynard AI Summarizer. Produce clear summaries while preserving important information.",
  assistant: "You are Maynard AI Personal Assistant. Help organize tasks, plans, ideas and schedules."
};

function send(res, status, data) {
  res.status(status).json(data);
}

function rateLimit(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : "unknown";

  const now = Date.now();
  const previous = requests.get(ip);

  if (previous && now - previous.start < 60000) {
    if (previous.count >= 15) return false;
    previous.count++;
  } else {
    requests.set(ip, { start: now, count: 1 });
  }

  // Keep the map from growing indefinitely.
  if (requests.size > 500) {
    for (const [key, value] of requests) {
      if (now - value.start > 120000) requests.delete(key);
    }
  }

  return true;
}

function validImage(file) {
  if (!file || typeof file.data !== "string") return false;

  const allowed = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  if (!allowed.includes(file.type)) return false;

  const prefix = `data:${file.type};base64,`;

  return file.data.startsWith(prefix) &&
    file.data.length <= 2800000;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, {
      error: "Only POST requests are supported."
    });
  }

  if (!rateLimit(req)) {
    return send(res, 429, {
      error: "Too many requests. Please wait a minute and try again."
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return send(res, 500, {
      error: "The Groq connection is not configured in Vercel."
    });
  }

  try {
    const body = req.body || {};

    const message = typeof body.message === "string"
      ? body.message.trim()
      : "";

    const mode = MODES[body.mode]
      ? body.mode
      : "general";

    const history = Array.isArray(body.history)
      ? body.history.slice(-MAX_HISTORY)
      : [];

    const attachments = Array.isArray(body.attachments)
      ? body.attachments.slice(0, MAX_ATTACHMENTS)
      : [];

    if (!message && attachments.length === 0) {
      return send(res, 400, {
        error: "Please enter a message or attach a file."
      });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return send(res, 400, {
        error: "Your message is too long."
      });
    }

    const userContent = [];
    let hasImage = false;

    if (message) {
      userContent.push({
        type: "text",
        text: message
      });
    }

    for (const file of attachments) {
      if (!file || typeof file !== "object") continue;

      if (file.kind === "image") {
        if (!validImage(file)) continue;

        userContent.push({
          type: "image_url",
          image_url: {
            url: file.data
          }
        });

        hasImage = true;
      }

      if (
        file.kind === "text" &&
        typeof file.text === "string"
      ) {
        userContent.push({
          type: "text",
          text:
            "\nAttached file: " +
            String(file.name || "document").slice(0, 100) +
            "\n" +
            file.text.slice(0, MAX_TEXT_FILE_LENGTH)
        });
      }
    }

    if (userContent.length === 0) {
      return send(res, 400, {
        error: "No supported attachment was received."
      });
    }

    const safeHistory = history
      .filter(item =>
        item &&
        ["user", "assistant"].includes(item.role) &&
        typeof item.content === "string"
      )
      .map(item => ({
        role: item.role,
        content: item.content.slice(0, 6000)
      }));

    const messages = [
      {
        role: "system",
        content:
          MODES[mode] +
          "\nYour name is Maynard AI. Be helpful, respectful, " +
          "honest and clear. Do not invent facts, sources or capabilities. " +
          "If you cannot perform an action, explain the limitation."
      },
      ...safeHistory,
      {
        role: "user",
        content: hasImage
          ? userContent
          : userContent
              .filter(item => item.type === "text")
              .map(item => item.text)
              .join("\n")
      }
    ];

    const selectedModel = hasImage
      ? VISION_MODEL
      : TEXT_MODEL;

    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: selectedModel,
          messages,
          max_tokens: 2048,
          temperature: 0.7
        })
      }
    );

    const result = await groqResponse.json();

    if (!groqResponse.ok) {
      console.error("Groq error:", result);

      return send(res, groqResponse.status, {
        error:
          result?.error?.message ||
          "Groq could not process your request. Try again later."
      });
    }

    const reply =
      result?.choices?.[0]?.message?.content;

    if (typeof reply !== "string" || !reply.trim()) {
      return send(res, 502, {
        error: "The AI returned an empty response."
      });
    }

    return send(res, 200, {
      success: true,
      reply: reply.trim(),
      model: selectedModel,
      mode,
      usage: result.usage || null
    });

  } catch (error) {
    console.error("Maynard backend error:", error);

    return send(res, 500, {
      error: "An unexpected server error occurred. Please try again."
    });
  }
}
