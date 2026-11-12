
import { createHash, randomUUID } from "node:crypto";

// Maynard AI — Vercel + Groq + Upstash Redis

export const config = { maxDuration: 60 };

const API_URL = "https://api.groq.com/openai/v1/chat/completions";

const TEXT_MODEL =
  process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";

const MAX_TOKENS = 2048;
const MAX_MESSAGES = 60;
const DAILY_IMAGE_LIMIT = 15;
const IMAGES_PER_BATCH = 3;
const HISTORY_MESSAGES = 8;

function fail(res, status, message) {
  return res.status(status).json({
    error: { message }
  });
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";");

  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index < 0) continue;

    const key = cookie.slice(0, index).trim();
    const value = cookie.slice(index + 1).trim();

    if (key === name) return decodeURIComponent(value);
  }

  return null;
}

function getVisitorId(req, res) {
  let id = getCookie(req, "maynard_visitor");

  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
    id = randomUUID();

    res.setHeader(
      "Set-Cookie",
      "maynard_visitor=" + id +
      "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000"
    );
  }

  return createHash("sha256").update(id).digest("hex");
}

function getGhanaDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Accra",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function secondsUntilMidnightGhana() {
  const now = new Date();
  const date = getGhanaDate();

  const nextMidnight = new Date(
    date + "T00:00:00.000Z"
  );

  nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);

  return Math.max(
    60,
    Math.ceil((nextMidnight.getTime() - now.getTime()) / 1000)
  );
}

async function reserveImages(visitorId, amount) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Image usage tracking is not configured.");
  }

  const date = getGhanaDate();
  const key = `maynard:images:${visitorId}:${date}`;
  const ttl = secondsUntilMidnightGhana();

  // Atomic: either reserve all requested images or none.
  const script = `
    local current = tonumber(redis.call("GET", KEYS[1]) or "0")
    local requested = tonumber(ARGV[1])
    local maximum = tonumber(ARGV[2])

    if current + requested > maximum then
      return {0, current}
    end

    local updated = redis.call("INCRBY", KEYS[1], requested)
    redis.call("EXPIRE", KEYS[1], tonumber(ARGV[3]))

    return {1, updated}
  `;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify([
      "EVAL",
      script,
      "1",
      key,
      String(amount),
      String(DAILY_IMAGE_LIMIT),
      String(ttl)
    ])
  });

  if (!response.ok) {
    throw new Error("Could not contact usage database.");
  }

  const data = await response.json();

  if (data.error) {
    throw new Error("Usage database error.");
  }

  const result = data.result;

  if (!Array.isArray(result)) {
    throw new Error("Invalid usage database response.");
  }

  return {
    allowed: Number(result[0]) === 1,
    used: Number(result[1])
  };
}

function extractImageBlocks(messages) {
  const latestUser = [...messages]
    .reverse()
    .find((message) => message && message.role === "user");

  if (!latestUser || !Array.isArray(latestUser.content)) {
    return { images: [], question: "" };
  }

  const images = [];
  const text = [];

  for (const block of latestUser.content) {
    if (!block) continue;

    if (block.type === "text" && block.text) {
      text.push(String(block.text));
    }

    if (
      block.type === "image" &&
      block.source &&
      block.source.type === "base64" &&
      /^image\/(jpeg|png|webp|gif)$/i.test(
        block.source.media_type || ""
      ) &&
      typeof block.source.data === "string" &&
      block.source.data.length > 0
    ) {
      images.push({
        media_type: block.source.media_type,
        data: block.source.data
      });
    }
  }

  return {
    images,
    question: text.join("\n").slice(0, 5000)
  };
}

function makeTextHistory(messages, system) {
  const output = [];

  if (typeof system === "string" && system) {
    output.push({
      role: "system",
      content: system.slice(0, 4000)
    });
  }

  const history = messages.slice(-HISTORY_MESSAGES);

  for (const message of history) {
    if (!message || !["user", "assistant"].includes(message.role)) {
      continue;
    }

    let content = "";

    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content
        .filter((block) => block && block.type === "text")
        .map((block) => String(block.text || ""))
        .join("\n");
    }

    if (!content.trim()) continue;

    output.push({
      role: message.role,
      content: content.slice(0, 4000)
    });
  }

  return output;
}

async function groqRequest(apiKey, body, signal) {
  const response = await fetch(API_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();

    if (response.status === 429) {
      throw new Error(
        "The AI service is busy or its usage limit has been reached. Please wait a little and try again."
      );
    }

    throw new Error(
      "AI service error (" + response.status + "): " +
      errorText.slice(0, 500)
    );
  }

  return response;
}

async function analyzeImageBatch(
  apiKey,
  history,
  question,
  images,
  batchNumber,
  totalBatches,
  signal
) {
  const imageParts = images.map((image) => ({
    type: "image_url",
    image_url: {
      url:
        "data:" +
        image.media_type +
        ";base64," +
        image.data
    }
  }));

  const prompt = question ||
    "Carefully examine these images and explain what they show.";

  const messages = [
    ...history,
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            prompt +
            "\n\nThis is image batch " +
            batchNumber +
            " of " +
            totalBatches +
            ". Examine every image in this batch carefully. " +
            "Describe useful details and do not invent information."
        },
        ...imageParts
      ]
    }
  ];

  const response = await groqRequest(
    apiKey,
    {
      model: VISION_MODEL,
      max_tokens: 1200,
      stream: false,
      messages
    },
    signal
  );

  const data = await response.json();

  return (
    data.choices?.[0]?.message?.content ||
    "No image analysis was returned for this batch."
  );
}

async function streamFinalAnswer(
  apiKey,
  messages,
  res,
  signal
) {
  const upstream = await groqRequest(
    apiKey,
    {
      model: TEXT_MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      messages
    },
    signal
  );

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const send = (object) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write("data: " + JSON.stringify(object) + "\n\n");
    }
  };

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of upstream.body) {
      if (signal.aborted || res.destroyed) break;

      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();

        if (!payload || payload === "[DONE]") continue;

        let event;

        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        if (event.error) {
          send({
            type: "error",
            error: {
              message: event.error.message || "Stream error."
            }
          });
          continue;
        }

        const content =
          event.choices?.[0]?.delta?.content;

        if (typeof content === "string" && content) {
          send({
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: content
            }
          });
        }
      }
    }
  } catch {
    // The visitor may have closed the connection.
  }

  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "Use POST.");
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return fail(res, 500, "The server is missing GROQ_API_KEY.");
  }

  const { messages, system } = req.body || {};

  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES
  ) {
    return fail(
      res,
      400,
      "Send a non-empty messages array (maximum " +
      MAX_MESSAGES +
      ")."
    );
  }

  const { images, question } = extractImageBlocks(messages);

  if (images.length > DAILY_IMAGE_LIMIT) {
    return fail(
      res,
      400,
      "You can upload up to 15 images in one request."
    );
  }

  const controller = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  // Requests without images use the normal text model.
  if (images.length === 0) {
    const history = makeTextHistory(messages, system);

    if (!history.some((message) => message.role === "user")) {
      return fail(res, 400, "No usable message content.");
    }

    try {
      await streamFinalAnswer(
        apiKey,
        history,
        res,
        controller.signal
      );
    } catch (error) {
      if (!res.headersSent) {
        return fail(res, 502, error.message);
      }

      if (!res.writableEnded && !res.destroyed) {
        res.write(
          "data: " +
          JSON.stringify({
            type: "error",
            error: { message: error.message }
          }) +
          "\n\n"
        );
        res.end();
      }
    }

    return;
  }

  // Reserve the daily allowance before processing images.
  let usage;

  try {
    const visitorId = getVisitorId(req, res);
    usage = await reserveImages(visitorId, images.length);
  } catch (error) {
    return fail(
      res,
      503,
      "Image usage tracking is temporarily unavailable. Please try again later."
    );
  }

  if (!usage.allowed) {
    return fail(
      res,
      429,
      "You have used your 15-image daily allowance. Your allowance resets at midnight Ghana time."
    );
  }

  try {
    const history = makeTextHistory(messages, system);

    const batches = [];

    for (
      let i = 0;
      i < images.length;
      i += IMAGES_PER_BATCH
    ) {
      batches.push(
        images.slice(i, i + IMAGES_PER_BATCH)
      );
    }

    const findings = [];

    // Process the images in groups of three.
    for (let i = 0; i < batches.length; i++) {
      if (controller.signal.aborted) return;

      const result = await analyzeImageBatch(
        apiKey,
        history,
        question,
        batches[i],
        i + 1,
        batches.length,
        controller.signal
      );

      findings.push(
        "IMAGE BATCH " +
        (i + 1) +
        ":\n" +
        result
      );
    }

    if (controller.signal.aborted) return;

    const finalMessages = [
      ...history,
      {
        role: "user",
        content:
          "I uploaded " +
          images.length +
          " images. Here are the analysis results from all image batches:\n\n" +
          findings.join("\n\n") +
          "\n\nNow answer my original request clearly. " +
          "Combine the findings from all images, avoid repeating yourself, " +
          "and explain any important differences between the images.\n\n" +
          "My original request: " +
          (question || "Explain what these images show.")
      }
    ];

    await streamFinalAnswer(
      apiKey,
      finalMessages,
      res,
      controller.signal
    );

  } catch (error) {
    if (controller.signal.aborted) return;

    if (!res.headersSent) {
      return fail(res, 502, error.message);
    }

    if (!res.writableEnded && !res.destroyed) {
      res.write(
        "data: " +
        JSON.stringify({
          type: "error",
          error: {
            message: error.message || "Image processing failed."
          }
        }) +
        "\n\n"
      );

      res.end();
    }
  }
}
