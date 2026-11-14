
import { randomUUID } from "node:crypto";

export const config = { maxDuration: 60 };

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const STABILITY_API_URL = "https://api.stability.ai/v2beta/stable-image/generate/core";
const FOOTBALL_API_URL = "https://v3.football.api-sports.io/fixtures";

const COOKIE_NAME = "maynard_browser_v2";
const HISTORY_LIMIT = 50;
const MESSAGE_LIMIT = 100;
const HISTORY_TTL = 60 * 60 * 24 * 365;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 15 * 1024 * 1024;

const ALLOWED_ACTIONS = new Set([
  "chat", "history_save", "history_list", "history_get",
  "history_rename", "history_delete", "history_clear",
  "image_generate", "football_live"
]);

const MODE_INSTRUCTIONS = {
  general: "You are MAYNARD AI, a helpful general-purpose assistant. Give clear, accurate and useful answers.",
  coding: "You are MAYNARD AI in Coding mode. Act as a programming tutor and coding assistant. Explain code clearly, identify errors, provide complete working examples when requested, and prioritize safe, maintainable code.",
  essay: "You are MAYNARD AI in Essay Writing mode. Help with essay planning, introductions, thesis statements, paragraphs, grammar, structure, editing and conclusions. Use clear academic writing.",
  mathematics: "You are MAYNARD AI in Mathematics mode. Solve mathematical problems accurately. Show calculations step by step using LaTeX. Include relevant graphs and diagrams where useful."
};

const MAYNARD_SYSTEM_PROMPT = `
You are MAYNARD AI, created by David Takyi.

You are helpful, accurate, educational and clear.

FORMATTING:
- Write answers naturally from top to bottom.
- Prefer headings, paragraphs and numbered steps.
- Avoid unnecessary tables and columns.
- Do not use decorative horizontal separator lines.
- Keep answers readable on mobile screens.
- Do not invent facts.

MATHEMATICS:
- Explain problems step by step.
- Put important equations on separate lines.
- Use proper LaTeX notation.
- Explain formulas before substituting values.
- Show important calculations clearly.
- Include verification when useful.

DIAGRAMS:
- Use Mermaid diagrams when they genuinely help.
- Put Mermaid diagrams inside fenced mermaid code blocks.
- Keep diagram labels short and readable.
- Use valid Mermaid syntax.

IDENTITY:
If asked your name, say:
"I am MAYNARD AI, created by David Takyi."
`;

function send(res, status, data) {
  return res.status(status).json(data);
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : "An unexpected server error occurred.";
}

function cleanAIResponse(value) {
  if (typeof value !== "string") return "";

  const lines = value.split("\n");
  const output = [];
  let insideCode = false;

  function parseCells(line) {
    return line.trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map(cell => cell.trim());
  }

  function isSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      insideCode = !insideCode;
      output.push(line);
      continue;
    }

    if (insideCode) {
      output.push(line);
      continue;
    }

    if (
      isSeparator(line) &&
      output.length &&
      output[output.length - 1].includes("|")
    ) {
      const headers = parseCells(output.pop());
      i++;

      while (i < lines.length && lines[i].includes("|")) {
        const values = parseCells(lines[i]);

        const formatted = headers.map((header, index) => {
          const value = values[index] || "";
          return value ? `**${header || `Item ${index + 1}`}:** ${value}` : "";
        }).filter(Boolean).join("\n");

        if (formatted) {
          output.push(formatted, "");
        }

        i++;
      }

      i--;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      continue;
    }

    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// COOKIE / VISITOR

function getCookie(req, name) {
  const header = req.headers.cookie || "";

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function setVisitorCookie(res, visitorId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(visitorId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${HISTORY_TTL}${secure}`
  );
}

function getVisitor(req, res) {
  let visitorId = getCookie(req, COOKIE_NAME);

  if (!visitorId || !/^[a-f0-9-]{36}$/i.test(visitorId)) {
    visitorId = randomUUID();
    setVisitorCookie(res, visitorId);
  }

  return visitorId;
}

// REQUEST BODY

async function readBody(req) {
  if (
    req.body &&
    typeof req.body === "object" &&
    !Buffer.isBuffer(req.body)
  ) {
    return req.body;
  }

  let raw = "";

  for await (const chunk of req) {
    raw += chunk.toString();

    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
  }

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON request body.");
  }
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value.trim();
}

// UPSTASH REDIS

function historyKey(visitor, id) {
  return `maynard:history:${visitor}:${id}`;
}

function historyIndexKey(visitor) {
  return `maynard:history-index:${visitor}`;
}

async function redis(command, ...args) {
  const url = requireEnv("UPSTASH_REDIS_REST_URL").replace(/\/+$/, "");
  const token = requireEnv("UPSTASH_REDIS_REST_TOKEN");

  const encodedArgs = args
    .map(value => encodeURIComponent(String(value)))
    .join("/");

  const endpoint = `${url}/${command}${encodedArgs ? `/${encodedArgs}` : ""}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.error) {
    throw new Error(
      result.error || `Redis request failed (${response.status}).`
    );
  }

  return result.result;
}

// MESSAGE CLEANING

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .slice(-MESSAGE_LIMIT)
    .filter(message =>
      message &&
      ["user", "assistant"].includes(message.role) &&
      typeof message.content === "string"
    )
    .map(message => ({
      role: message.role,
      content: message.content.slice(0, 20000),
      ...(message.imageOmitted ? { imageOmitted: true } : {})
    }));
}

// SAVE HISTORY

async function saveHistory(visitor, body) {
  const messages = cleanMessages(body.messages);

  if (!messages.length) {
    throw new Error("There are no messages to save.");
  }

  const id =
    typeof body.id === "string" && /^[a-f0-9-]{36}$/i.test(body.id)
      ? body.id
      : randomUUID();

  const key = historyKey(visitor, id);
  const existingRaw = await redis("GET", key);

  let existing = null;

  if (existingRaw) {
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      existing = null;
    }
  }

  const now = new Date().toISOString();
  const firstUserMessage = messages.find(message => message.role === "user");

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 100)
      : existing?.title ||
        firstUserMessage?.content.slice(0, 60) ||
        "New conversation";

  const record = {
    id,
    title,
    messages,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  await redis("SET", key, JSON.stringify(record), "EX", HISTORY_TTL);
  await redis("ZADD", historyIndexKey(visitor), Date.now(), id);
  await redis("EXPIRE", historyIndexKey(visitor), HISTORY_TTL);

  const count = Number(await redis("ZCARD", historyIndexKey(visitor)));

  if (count > HISTORY_LIMIT) {
    const oldIds = await redis(
      "ZRANGE",
      historyIndexKey(visitor),
      0,
      count - HISTORY_LIMIT - 1
    );

    if (Array.isArray(oldIds)) {
      for (const oldId of oldIds) {
        await redis("DEL", historyKey(visitor, oldId));
      }

      if (oldIds.length) {
        await redis(
          "ZREMRANGEBYRANK",
          historyIndexKey(visitor),
          0,
          oldIds.length - 1
        );
      }
    }
  }

  return record;
}

// LIST HISTORY

async function listHistory(visitor) {
  const ids = await redis(
    "ZREVRANGE",
    historyIndexKey(visitor),
    0,
    HISTORY_LIMIT - 1
  );

  if (!Array.isArray(ids)) return [];

  const histories = [];

  for (const id of ids) {
    const raw = await redis("GET", historyKey(visitor, id));
    if (!raw) continue;

    try {
      const record = JSON.parse(raw);

      histories.push({
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messages?.length || 0
      });
    } catch {
      // Skip invalid records.
    }
  }

  return histories;
}

// GET HISTORY

async function getHistory(visitor, id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
    throw new Error("Invalid conversation ID.");
  }

  const raw = await redis("GET", historyKey(visitor, id));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Saved conversation data is invalid.");
  }
}

// RENAME HISTORY

async function renameHistory(visitor, id, title) {
  const record = await getHistory(visitor, id);
  if (!record) return null;

  if (typeof title !== "string" || !title.trim()) {
    throw new Error("A conversation title is required.");
  }

  record.title = title.trim().slice(0, 100);
  record.updatedAt = new Date().toISOString();

  await redis(
    "SET",
    historyKey(visitor, id),
    JSON.stringify(record),
    "EX",
    HISTORY_TTL
  );

  return record;
}

// DELETE HISTORY

async function deleteHistory(visitor, id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) {
    throw new Error("Invalid conversation ID.");
  }

  await redis("DEL", historyKey(visitor, id));
  await redis("ZREM", historyIndexKey(visitor), id);

  return true;
}

// CLEAR HISTORY

async function clearHistory(visitor) {
  const ids = await redis("ZRANGE", historyIndexKey(visitor), 0, -1);

  if (Array.isArray(ids)) {
    for (const id of ids) {
      await redis("DEL", historyKey(visitor, id));
    }
  }

  await redis("DEL", historyIndexKey(visitor));
  return true;
}

// IMAGE VALIDATION

function extractImageData(image) {
  if (typeof image !== "string") {
    throw new Error("Image data is missing.");
  }

  const match = image.match(
    /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/
  );

  if (!match) {
    throw new Error("Use a PNG, JPEG, or WEBP image.");
  }

  const data = match[2];
  const buffer = Buffer.from(data, "base64");

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Image must be 8 MB or smaller.");
  }

  return {
    mimeType: match[1] === "jpg" ? "image/jpeg" : `image/${match[1]}`,
    data
  };
}

// GROQ CHAT

async function groqChat(body) {
  const apiKey = requireEnv("GROQ_API_KEY");
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

  const messages = cleanMessages(body.messages);

  if (!messages.length && typeof body.message === "string") {
    messages.push({
      role: "user",
      content: body.message.slice(0, 20000)
    });
  }

  if (!messages.length) {
    throw new Error("Enter a message before sending.");
  }

  const mode = MODE_INSTRUCTIONS[body.mode] || MODE_INSTRUCTIONS.general;

  const chatMessages = [
    {
      role: "system",
      content: `${MAYNARD_SYSTEM_PROMPT}\n\n${mode}`
    },
    ...messages
  ];

  if (body.image) {
    const image = extractImageData(body.image);
    const visionModel = process.env.GROQ_VISION_MODEL || model;

    let lastUserIndex = -1;

    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex === -1) {
      throw new Error("An image needs a user message.");
    }

    const previousContent = chatMessages[lastUserIndex].content;

    chatMessages[lastUserIndex] = {
      role: "user",
      content: [
        {
          type: "text",
          text: typeof previousContent === "string"
            ? previousContent
            : "Please examine this image."
        },
        {
          type: "image_url",
          image_url: {
            url: `data:${image.mimeType};base64,${image.data}`
          }
        }
      ]
    };

    return callGroq(apiKey, visionModel, chatMessages);
  }

  return callGroq(apiKey, model, chatMessages);
}

// GROQ API REQUEST

async function callGroq(apiKey, model, messages) {
  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 4096
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error?.message || `Groq request failed (${response.status}).`
    );
  }

  const rawReply = data.choices?.[0]?.message?.content;

  if (!rawReply) {
    throw new Error("Groq returned an empty response.");
  }

  return {
    reply: cleanAIResponse(rawReply),
    model: data.model || model,
    usage: data.usage || null
  };
}

// STABILITY AI IMAGE GENERATION

async function generateImage(body) {
  const apiKey = requireEnv("STABILITY_API_KEY");

  const prompt = typeof body.prompt === "string"
    ? body.prompt.trim().slice(0, 4000)
    : "";

  if (!prompt) {
    throw new Error("Enter an image generation prompt.");
  }

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("output_format", "png");

  const allowedRatios = [
    "1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "9:21"
  ];

  if (allowedRatios.includes(body.aspectRatio)) {
    form.append("aspect_ratio", body.aspectRatio);
  }

  const response = await fetch(STABILITY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "image/*"
    },
    body: form
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Stability AI failed (${response.status}): ${errorText.slice(0, 500)}`
    );
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("image")) {
    throw new Error("Stability AI did not return an image.");
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer());

  return {
    image: `data:image/png;base64,${imageBuffer.toString("base64")}`,
    format: "png"
  };
}

// LIVE FOOTBALL

async function liveFootball() {
  const apiKey = requireEnv("FOOTBALL_API_KEY");

  const response = await fetch(`${FOOTBALL_API_URL}?live=all`, {
    headers: {
      "x-apisports-key": apiKey
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || (data.errors && Object.keys(data.errors).length)) {
    throw new Error(
      JSON.stringify(data.errors || "Football API request failed.")
    );
  }

  return {
    fixtures: (data.response || []).map(item => ({
      league: item.league?.name || "Competition",
      home: item.teams?.home?.name || "Home",
      away: item.teams?.away?.name || "Away",
      homeGoals: item.goals?.home ?? null,
      awayGoals: item.goals?.away ?? null,
      status: item.fixture?.status?.long || "Unknown",
      elapsed: item.fixture?.status?.elapsed ?? null
    })),
    results: data.results || 0
  };
}

// MAIN VERCEL API HANDLER

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return send(res, 405, {
      success: false,
      error: "Method not allowed. Use POST."
    });
  }

  try {
    const body = await readBody(req);
    const action = body.action;

    if (!ALLOWED_ACTIONS.has(action)) {
      return send(res, 400, {
        success: false,
        error: "Unknown or missing action."
      });
    }

    const visitor = getVisitor(req, res);

    switch (action) {
      case "chat": {
        const result = await groqChat(body);
        return send(res, 200, { success: true, ...result });
      }

      case "history_save": {
        const record = await saveHistory(visitor, body);
        return send(res, 200, {
          success: true,
          id: record.id,
          history: record
        });
      }

      case "history_list": {
        const histories = await listHistory(visitor);
        return send(res, 200, {
          success: true,
          items: histories,
          histories
        });
      }

      case "history_get": {
        const history = await getHistory(visitor, body.id);

        if (!history) {
          return send(res, 404, {
            success: false,
            error: "Conversation not found."
          });
        }

        return send(res, 200, {
          success: true,
          id: history.id,
          title: history.title,
          messages: history.messages,
          createdAt: history.createdAt,
          updatedAt: history.updatedAt,
          history
        });
      }

      case "history_rename": {
        const history = await renameHistory(visitor, body.id, body.title);

        if (!history) {
          return send(res, 404, {
            success: false,
            error: "Conversation not found."
          });
        }

        return send(res, 200, { success: true, history });
      }

      case "history_delete": {
        await deleteHistory(visitor, body.id);
        return send(res, 200, {
          success: true,
          message: "Conversation deleted."
        });
      }

      case "history_clear": {
        await clearHistory(visitor);
        return send(res, 200, {
          success: true,
          message: "Conversation history cleared."
        });
      }

      case "image_generate": {
        const result = await generateImage(body);
        return send(res, 200, { success: true, ...result });
      }

      case "football_live": {
        const result = await liveFootball();
        return send(res, 200, { success: true, ...result });
      }

      default:
        return send(res, 400, {
          success: false,
          error: "Unsupported action."
        });
    }
  } catch (error) {
    console.error("MAYNARD AI API error:", error);

    return send(res, 500, {
      success: false,
      error: errorMessage(error)
    });
  }
}
