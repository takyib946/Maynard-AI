
import { randomUUID } from "node:crypto";

export const config = {
  maxDuration: 60,
};

const GROQ_API_URL =
  "https://api.groq.com/openai/v1/chat/completions";

const STABILITY_API_URL =
  "https://api.stability.ai/v2beta/stable-image/generate/core";

const FOOTBALL_API_URL =
  "https://v3.football.api-sports.io/fixtures";

const COOKIE_NAME = "maynard_browser_v2";
const HISTORY_LIMIT = 50;
const MESSAGE_LIMIT = 100;
const HISTORY_TTL = 60 * 60 * 24 * 365;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const allowedActions = new Set([
  "chat",
  "history_save",
  "history_list",
  "history_get",
  "history_rename",
  "history_delete",
  "history_clear",
  "image_generate",
  "football_live",
]);

function send(res, status, data) {
  res.status(status).json(data);
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  const parts = cookie.split(";");

  for (const part of parts) {
    const index = part.indexOf("=");
    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

function setVisitorCookie(res, visitorId) {
  const secure =
    process.env.NODE_ENV === "production" ? "; Secure" : "";

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

async function readBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  let raw = "";

  for await (const chunk of req) {
    raw += chunk;

    if (raw.length > 15 * 1024 * 1024) {
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

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function historyKey(visitor, id) {
  return `maynard:history:${visitor}:${id}`;
}

function historyIndexKey(visitor) {
  return `maynard:history-index:${visitor}`;
}

async function redis(command, ...args) {
  const url = requireEnv("UPSTASH_REDIS_REST_URL");
  const token = requireEnv("UPSTASH_REDIS_REST_TOKEN");

  const response = await fetch(
    `${url.replace(/\/$/, "")}/${command}/${args
      .map((value) => encodeURIComponent(String(value)))
      .join("/")}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  const result = await response.json();

  if (!response.ok || result.error) {
    throw new Error(result.error || "Redis request failed.");
  }

  return result.result;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .slice(-MESSAGE_LIMIT)
    .filter(
      (message) =>
        message &&
        ["user", "assistant"].includes(message.role) &&
        typeof message.content === "string"
    )
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 20000),
      ...(message.imageOmitted ? { imageOmitted: true } : {}),
    }));
}

async function saveHistory(visitor, body) {
  const messages = cleanMessages(body.messages);

  if (!messages.length) {
    throw new Error("There are no messages to save.");
  }

  const id =
    typeof body.id === "string" &&
    /^[a-f0-9-]{36}$/i.test(body.id)
      ? body.id
      : randomUUID();

  const now = new Date().toISOString();

  const existingRaw = await redis(
    "GET",
    historyKey(visitor, id)
  );

  let existing = null;

  if (existingRaw) {
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      existing = null;
    }
  }

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 100)
      : existing?.title ||
        messages.find((message) => message.role === "user")
          ?.content.slice(0, 60) ||
        "New conversation";

  const record = {
    id,
    title,
    messages,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await redis(
    "SET",
    historyKey(visitor, id),
    JSON.stringify(record),
    "EX",
    HISTORY_TTL
  );

  await redis(
    "ZADD",
    historyIndexKey(visitor),
    Date.now(),
    id
  );

  await redis(
    "EXPIRE",
    historyIndexKey(visitor),
    HISTORY_TTL
  );

  const count = await redis(
    "ZCARD",
    historyIndexKey(visitor)
  );

  if (Number(count) > HISTORY_LIMIT) {
    const oldIds = await redis(
      "ZRANGE",
      historyIndexKey(visitor),
      0,
      Number(count) - HISTORY_LIMIT - 1
    );

    if (Array.isArray(oldIds)) {
      for (const oldId of oldIds) {
        await redis(
          "DEL",
          historyKey(visitor, oldId)
        );
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
    const raw = await redis(
      "GET",
      historyKey(visitor, id)
    );

    if (!raw) continue;

    try {
      const record = JSON.parse(raw);

      histories.push({
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messages?.length || 0,
      });
    } catch {
      // Ignore invalid history records.
    }
  }

  return histories;
}

async function getHistory(visitor, id) {
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
    throw new Error("Invalid conversation ID.");
  }

  const raw = await redis(
    "GET",
    historyKey(visitor, id)
  );

  if (!raw) return null;

  return JSON.parse(raw);
}

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

async function deleteHistory(visitor, id) {
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
    throw new Error("Invalid conversation ID.");
  }

  await redis("DEL", historyKey(visitor, id));
  await redis("ZREM", historyIndexKey(visitor), id);

  return true;
}

async function clearHistory(visitor) {
  const ids = await redis(
    "ZRANGE",
    historyIndexKey(visitor),
    0,
    -1
  );

  if (Array.isArray(ids)) {
    for (const id of ids) {
      await redis(
        "DEL",
        historyKey(visitor, id)
      );
    }
  }

  await redis("DEL", historyIndexKey(visitor));

  return true;
}

function extractImageData(image) {
  if (typeof image !== "string") {
    throw new Error("Image data is missing.");
  }

  const match = image.match(
    /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/
  );

  if (!match) {
    throw new Error(
      "Use a PNG, JPEG, or WEBP image."
    );
  }

  const buffer = Buffer.from(match[2], "base64");

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Image must be 8 MB or smaller.");
  }

  return {
    mimeType:
      match[1] === "jpg" ? "image/jpeg" : `image/${match[1]}`,
    data: match[2],
  };
}

async function groqChat(body) {
  const apiKey = requireEnv("GROQ_API_KEY");

  const model =
    process.env.GROQ_MODEL ||
    "llama-3.3-70b-versatile";

  const messages = Array.isArray(body.messages)
    ? body.messages
        .filter(
          (message) =>
            message &&
            ["system", "user", "assistant"].includes(message.role)
        )
        .slice(-MESSAGE_LIMIT)
        .map((message) => ({
          role: message.role,
          content:
            typeof message.content === "string"
              ? message.content.slice(0, 20000)
              : message.content,
        }))
    : [];

  if (!messages.length && typeof body.message === "string") {
    messages.push({
      role: "user",
      content: body.message.slice(0, 20000),
    });
  }

  if (!messages.length) {
    throw new Error("Enter a message before sending.");
  }

  if (body.image) {
    const image = extractImageData(body.image);
    const visionModel =
      process.env.GROQ_VISION_MODEL || model;

    const lastUserIndex = messages.findLastIndex(
      (message) => message.role === "user"
    );

    if (lastUserIndex === -1) {
      throw new Error("An image needs a user message.");
    }

    const previousContent =
      messages[lastUserIndex].content;

    messages[lastUserIndex] = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            typeof previousContent === "string"
              ? previousContent
              : "Please describe this image.",
        },
        {
          type: "image_url",
          image_url: {
            url: `data:${image.mimeType};base64,${image.data}`,
          },
        },
      ],
    };

    return await callGroq(apiKey, visionModel, messages);
  }

  return await callGroq(apiKey, model, messages);
}

async function callGroq(apiKey, model, messages) {
  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
        `Groq request failed (${response.status}).`
    );
  }

  const reply = data.choices?.[0]?.message?.content;

  if (!reply) {
    throw new Error("Groq returned an empty response.");
  }

  return {
    reply,
    model: data.model || model,
    usage: data.usage || null,
  };
}

async function generateImage(body) {
  const apiKey = requireEnv("STABILITY_API_KEY");

  const prompt =
    typeof body.prompt === "string"
      ? body.prompt.trim().slice(0, 4000)
      : "";

  if (!prompt) {
    throw new Error("Enter an image generation prompt.");
  }

  const form = new FormData();

  form.append("prompt", prompt);
  form.append("output_format", "png");

  if (body.aspectRatio) {
    const allowedRatios = [
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4",
      "21:9",
      "9:21",
    ];

    if (allowedRatios.includes(body.aspectRatio)) {
      form.append("aspect_ratio", body.aspectRatio);
    }
  }

  const response = await fetch(STABILITY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "image/*",
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Stability AI failed (${response.status}): ${errorText.slice(0, 500)}`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.includes("image")) {
    throw new Error(
      "Stability AI did not return an image."
    );
  }

  const imageBuffer = Buffer.from(
    await response.arrayBuffer()
  );

  return {
    image: `data:image/png;base64,${imageBuffer.toString("base64")}`,
    format: "png",
  };
}

async function liveFootball() {
  const apiKey = requireEnv("FOOTBALL_API_KEY");

  const response = await fetch(
    `${FOOTBALL_API_URL}?live=all`,
    {
      headers: {
        "x-apisports-key": apiKey,
      },
    }
  );

  const data = await response.json();

  if (!response.ok || data.errors?.length) {
    throw new Error(
      JSON.stringify(data.errors || "Football API request failed.")
    );
  }

  return {
    fixtures: data.response || [],
    results: data.results || 0,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return send(res, 405, {
      error: "Method not allowed. Use POST.",
    });
  }

  try {
    const body = await readBody(req);
    const action = body.action;

    if (!allowedActions.has(action)) {
      return send(res, 400, {
        error: "Unknown or missing action.",
      });
    }

    const visitor = getVisitor(req, res);

    switch (action) {
      case "chat": {
        const result = await groqChat(body);

        return send(res, 200, {
          success: true,
          ...result,
        });
      }

      case "history_save": {
        const record = await saveHistory(visitor, body);

        return send(res, 200, {
          success: true,
          history: record,
          id: record.id,
        });
      }

      case "history_list": {
        const histories = await listHistory(visitor);

        return send(res, 200, {
          success: true,
          histories,
        });
      }

      case "history_get": {
        const history = await getHistory(
          visitor,
          body.id
        );

        if (!history) {
          return send(res, 404, {
            error: "Conversation not found.",
          });
        }

        return send(res, 200, {
          success: true,
          history,
        });
      }

      case "history_rename": {
        const history = await renameHistory(
          visitor,
          body.id,
          body.title
        );

        if (!history) {
          return send(res, 404, {
            error: "Conversation not found.",
          });
        }

        return send(res, 200, {
          success: true,
          history,
        });
      }

      case "history_delete": {
        await deleteHistory(visitor, body.id);

        return send(res, 200, {
          success: true,
          message: "Conversation deleted.",
        });
      }

      case "history_clear": {
        await clearHistory(visitor);

        return send(res, 200, {
          success: true,
          message: "Conversation history cleared.",
        });
      }

      case "image_generate": {
        const result = await generateImage(body);

        return send(res, 200, {
          success: true,
          ...result,
        });
      }

      case "football_live": {
        const result = await liveFootball();

        return send(res, 200, {
          success: true,
          ...result,
        });
      }

      default:
        return send(res, 400, {
          error: "Unsupported action.",
        });
    }
  } catch (error) {
    console.error("MAYNARD AI API error:", error);

    return send(res, 500, {
      success: false,
      error:
        error.message ||
        "An unexpected server error occurred.",
    });
  }
}
