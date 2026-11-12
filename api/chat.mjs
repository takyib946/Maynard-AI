import { createHash, randomUUID } from "node:crypto";

// MAYNARD AI — Vercel + Groq + Upstash Redis + Stability AI

export const config = { maxDuration: 60 };

const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const STABILITY_IMAGE_URL =
  "https://api.stability.ai/v2beta/stable-image/generate/core";

const TEXT_MODEL =
  process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";

const MAX_TOKENS = 3072;
const MAX_MESSAGES = 60;
const DAILY_IMAGE_LIMIT = 15;
const DAILY_GENERATION_LIMIT = 3;
const IMAGES_PER_BATCH = 3;
const HISTORY_MESSAGES = 8;
const MAX_GENERATION_PROMPT = 2000;

const ALLOWED_ASPECT_RATIOS = new Set([
  "1:1",
  "16:9",
  "21:9",
  "2:3",
  "3:2",
  "4:5",
  "5:4",
  "9:16",
  "9:21"
]);

// ==========================================
// MAYNARD AI — ANSWER QUALITY INSTRUCTIONS
// ==========================================

const MAYNARD_RESPONSE_RULES = `
You are Maynard AI, an intelligent, helpful and accurate AI assistant.

YOUR MAIN GOAL:
Give users accurate, useful, understandable and complete answers.
Prioritize correctness over speed and unnecessary detail.

1. ACCURACY AND RELIABILITY

- Carefully understand the user's question before answering.
- Answer the actual question instead of changing its meaning.
- Do not invent facts, statistics, quotations, sources or references.
- Do not present guesses as confirmed facts.
- If information is uncertain, explain the uncertainty.
- If a question is ambiguous, ask for clarification when necessary.
- Check calculations and logical conclusions before responding.
- Correct mistakes when they are identified.
- Never pretend to have performed an action or checked information that you have not checked.
- Do not claim that information is current if you cannot verify that it is current.

2. ANSWER FORMATTING

- Use clear, natural paragraphs.
- Use headings when they improve organization.
- Use numbered steps for procedures and multi-step explanations.
- Use bullet points when listing related information.
- Do not automatically turn every answer into a table.
- Avoid unnecessary tables.
- Use a table only when it genuinely makes information easier to compare or understand, or when requested.
- Keep answers focused on the user's question.
- Avoid repeating the same information.
- Explain technical terms in understandable language when appropriate.

3. MATHEMATICS AND SYMBOLIC MATHEMATICS

- Support arithmetic, algebra, geometry, trigonometry, calculus, statistics and other mathematical subjects.
- Use accurate mathematical notation.
- Use LaTeX for mathematical expressions.
- Use \\( ... \\) for inline mathematics.
- Use \\[ ... \\] for displayed mathematics.
- Format fractions, roots, powers, subscripts and superscripts correctly.
- Show important calculations step by step.
- Explain why each important mathematical operation is performed.
- Check arithmetic and algebraic results.
- Verify answers by substitution or another suitable method when possible.
- Clearly identify the final answer.
- Never put an entire mathematical solution inside a table.
- Do not use mathematical notation unnecessarily in ordinary sentences.
- If a problem cannot be solved because information is missing, identify what is missing.

4. SCIENCE AND TECHNICAL SUBJECTS

- Explain scientific concepts accurately.
- Use correct terminology and units.
- Distinguish established scientific facts from theories, estimates and hypotheses.
- Show formulas and calculations where appropriate.
- Explain the meaning of symbols used in formulas.
- Do not invent experimental results or scientific evidence.

5. EDUCATIONAL QUESTIONS

- Give answers that directly address the question.
- Explain difficult concepts in simple language.
- Answer each part of a multi-part question separately.
- Show relevant working for calculations.
- Use examples when they genuinely help understanding.
- Respect requested answer lengths and formats.
- Do not leave out important parts of the question.
- Do not add unrelated information just to make an answer longer.

6. WRITING AND LANGUAGE

- Use correct spelling, grammar and punctuation.
- Write naturally and clearly.
- Preserve the intended meaning when rewriting text.
- Follow the requested language and tone.
- Do not change names, figures or important details without a reason.

7. IMAGE UNDERSTANDING

- Carefully examine all available uploaded images.
- Read visible text accurately.
- Answer the actual question associated with the image.
- Do not invent details that cannot be seen.
- If text is unclear or unreadable, say so.
- If multiple images are supplied, consider information from all of them.
- Explain relevant differences between images when necessary.

8. GENERAL KNOWLEDGE

- Separate facts from opinions.
- Do not make up historical dates, names or events.
- Avoid unsupported claims.
- When a question concerns changing information, explain when your knowledge may be outdated.
- Give useful context without overwhelming the user.

9. CONVERSATION

- Remember relevant information from the conversation provided to you.
- Use previous messages when they help answer the current question.
- Do not ask the user to repeat information already available.
- Do not repeat the entire conversation in every answer.
- If the user corrects a misunderstanding, follow the correction.

10. FINAL ANSWER QUALITY

Before responding, check:
- Did I answer the actual question?
- Is the answer logically consistent?
- Are calculations correct?
- Is the explanation understandable?
- Did I avoid unnecessary tables?
- Did I clearly identify uncertainty?
- Did I include all important parts?

Give the best accurate answer you can.
`;

// ==========================================
// BASIC RESPONSE HELPERS
// ==========================================

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

// ==========================================
// VISITOR IDENTIFICATION
// ==========================================

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

  return createHash("sha256")
    .update(id)
    .digest("hex");
}

// ==========================================
// GHANA DATE AND USAGE LIMITS
// ==========================================

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

  nextMidnight.setUTCDate(
    nextMidnight.getUTCDate() + 1
  );

  return Math.max(
    60,
    Math.ceil(
      (nextMidnight.getTime() - now.getTime()) / 1000
    )
  );
}

// ==========================================
// UPSTASH REDIS USAGE RESERVATION
// ==========================================

async function reserveUsage(visitorId, amount, category, maximum) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Usage tracking is not configured.");
  }

  const date = getGhanaDate();
  const key = `maynard:${category}:${visitorId}:${date}`;
  const ttl = secondsUntilMidnightGhana();

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
      String(maximum),
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

async function reserveImages(visitorId, amount) {
  return reserveUsage(
    visitorId,
    amount,
    "images",
    DAILY_IMAGE_LIMIT
  );
}

async function reserveGenerations(visitorId) {
  return reserveUsage(
    visitorId,
    1,
    "generations",
    DAILY_GENERATION_LIMIT
  );
}

// ==========================================
// STABILITY AI IMAGE GENERATION
// ==========================================

async function generateStabilityImage(prompt, aspectRatio) {
  const apiKey = process.env.STABILITY_API_KEY;

  if (!apiKey) {
    const error = new Error(
      "Image generation is not configured. Add STABILITY_API_KEY to your Vercel environment variables."
    );
    error.status = 500;
    throw error;
  }

  const form = new FormData();

  form.append("prompt", prompt);
  form.append("aspect_ratio", aspectRatio);
  form.append("output_format", "png");

  const response = await fetch(STABILITY_IMAGE_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      Accept: "image/*"
    },
    body: form
  });

  if (!response.ok) {
    const responseText = await response.text();
    let providerMessage = "";

    try {
      const parsed = JSON.parse(responseText);
      providerMessage =
        parsed.message ||
        parsed.error?.message ||
        parsed.name ||
        "";
    } catch {
      providerMessage = responseText.slice(0, 500);
    }

    const error = new Error(
      providerMessage ||
      "Stability AI could not generate the image."
    );

    error.status = response.status;
    throw error;
  }

  const mimeType =
    response.headers.get("content-type") || "image/png";

  if (!mimeType.startsWith("image/")) {
    const error = new Error(
      "Stability AI returned an unexpected response."
    );
    error.status = 502;
    throw error;
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (!buffer.length) {
    const error = new Error(
      "Stability AI returned an empty image."
    );
    error.status = 502;
    throw error;
  }

  return {
    imageData:
      `data:${mimeType};base64,${buffer.toString("base64")}`,
    mimeType
  };
}

async function handleImageGeneration(req, res) {
  const prompt =
    typeof req.body?.prompt === "string"
      ? req.body.prompt.trim()
      : "";

  const aspectRatio =
    typeof req.body?.aspect_ratio === "string"
      ? req.body.aspect_ratio
      : "1:1";

  if (prompt.length < 3) {
    return fail(
      res,
      400,
      "Please enter a longer image description."
    );
  }

  if (prompt.length > MAX_GENERATION_PROMPT) {
    return fail(
      res,
      400,
      `Your image description must be ${MAX_GENERATION_PROMPT} characters or fewer.`
    );
  }

  if (!ALLOWED_ASPECT_RATIOS.has(aspectRatio)) {
    return fail(
      res,
      400,
      "That image aspect ratio is not supported."
    );
  }

  let visitorId;

  try {
    visitorId = getVisitorId(req, res);

    const usage = await reserveGenerations(visitorId);

    if (!usage.allowed) {
      return fail(
        res,
        429,
        "You have reached your daily image-generation limit of 3 images. Your allowance resets at midnight Ghana time."
      );
    }
  } catch (error) {
    console.error("Image generation usage error:", error);

    return fail(
      res,
      503,
      "Image generation usage tracking is temporarily unavailable. Please try again later."
    );
  }

  try {
    const result = await generateStabilityImage(
      prompt,
      aspectRatio
    );

    return res.status(200).json(result);

  } catch (error) {
    console.error("Stability AI error:", error);

    const status = Number(error.status) || 502;

    let message = error.message ||
      "Image generation failed. Please try again.";

    if (status === 401) {
      message = "Stability AI rejected the API key. Check STABILITY_API_KEY in Vercel.";
    } else if (status === 402) {
      message = "Your Stability AI account does not have enough credits to generate this image.";
    } else if (status === 403) {
      message = "Stability AI could not process this prompt. Try changing the description.";
    } else if (status === 429) {
      message = "Stability AI is receiving too many requests. Please wait and try again.";
    } else if (status >= 500) {
      message = "Stability AI is temporarily unavailable. Please try again later.";
    }

    return fail(
      res,
      status >= 400 && status <= 599 ? status : 502,
      message
    );
  }
}

// ==========================================
// IMAGE EXTRACTION
// ==========================================

function extractImageBlocks(messages) {
  const latestUser = [...messages]
    .reverse()
    .find(message => message && message.role === "user");

  if (
    !latestUser ||
    !Array.isArray(latestUser.content)
  ) {
    return {
      images: [],
      question: ""
    };
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

// ==========================================
// CONVERSATION HISTORY
// ==========================================

function makeTextHistory(
  messages,
  system,
  excludeLatestUser = false
) {
  const output = [];

  const systemInstructions = [
    MAYNARD_RESPONSE_RULES
  ];

  if (typeof system === "string" && system.trim()) {
    systemInstructions.push(
      "ADDITIONAL APP INSTRUCTIONS:\n" +
      system.slice(0, 4000)
    );
  }

  output.push({
    role: "system",
    content: systemInstructions.join("\n\n")
  });

  let history = messages.slice(-HISTORY_MESSAGES);

  if (excludeLatestUser) {
    let lastUserIndex = -1;

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex >= 0) {
      history = history.filter(
        (_, index) => index !== lastUserIndex
      );
    }
  }

  for (const message of history) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role)
    ) {
      continue;
    }

    let content = "";

    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content
        .filter(block => block && block.type === "text")
        .map(block => String(block.text || ""))
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

// ==========================================
// GROQ API REQUEST
// ==========================================

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

    let providerMessage = "";

    try {
      const parsed = JSON.parse(errorText);
      providerMessage = parsed.error?.message || "";
    } catch {
      providerMessage = "";
    }

    throw new Error(
      "AI service error (" +
      response.status +
      "): " +
      (providerMessage || "The AI request could not be completed.")
    );
  }

  return response;
}

// ==========================================
// IMAGE ANALYSIS
// ==========================================

async function analyzeImageBatch(
  apiKey,
  history,
  question,
  images,
  batchNumber,
  totalBatches,
  signal
) {
  const imageParts = images.map(image => ({
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
            ". Examine every image carefully. " +
            "Read visible text accurately. " +
            "Do not invent details. " +
            "If something is unclear, say so."
        },
        ...imageParts
      ]
    }
  ];

  const response = await groqRequest(
    apiKey,
    {
      model: VISION_MODEL,
      max_tokens: 1500,
      stream: false,
      messages
    },
    signal
  );

  const data = await response.json();

  const result =
    data.choices?.[0]?.message?.content;

  if (!result) {
    throw new Error(
      "The vision model did not return an image analysis."
    );
  }

  return result;
}

// ==========================================
// STREAMING FINAL ANSWER
// ==========================================

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

  if (!upstream.body) {
    throw new Error(
      "The AI service returned an empty response."
    );
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const send = object => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(
        "data: " +
        JSON.stringify(object) +
        "\n\n"
      );
    }
  };

  const decoder = new TextDecoder();

  let buffer = "";
  let finished = false;

  function processLine(line) {
    if (!line.startsWith("data:")) return;

    const payload = line.slice(5).trim();

    if (!payload) return;

    if (payload === "[DONE]") {
      finished = true;
      return;
    }

    let event;

    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }

    if (event.error) {
      send({
        type: "error",
        error: {
          message:
            event.error.message ||
            "The AI stream encountered an error."
        }
      });

      return;
    }

    const content =
      event.choices?.[0]?.delta?.content;

    if (typeof content === "string" && content.length > 0) {
      send({
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: content
        }
      });
    }
  }

  try {
    for await (const chunk of upstream.body) {
      if (
        signal.aborted ||
        res.destroyed ||
        finished
      ) {
        break;
      }

      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        processLine(line);
        if (finished) break;
      }
    }

    buffer += decoder.decode();

    if (buffer.trim() && !finished) {
      processLine(buffer);
    }

  } catch (error) {
    if (!signal.aborted && !res.destroyed) {
      send({
        type: "error",
        error: {
          message:
            "The response was interrupted. Please try again."
        }
      });
    }
  }

  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
}

// ==========================================
// MAIN VERCEL HANDLER
// ==========================================

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "Use POST.");
  }

  const body = req.body || {};

  // IMAGE GENERATION REQUESTS ARE HANDLED SEPARATELY.
  // They do not require a Groq API key.

  if (body.action === "generate_image") {
    return handleImageGeneration(req, res);
  }

  // GROQ API KEY VALIDATION

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return fail(
      res,
      500,
      "The server is missing GROQ_API_KEY."
    );
  }

  // REQUEST VALIDATION

  const { messages, system } = body;

  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES
  ) {
    return fail(
      res,
      400,
      "Send a non-empty messages array with a maximum of " +
      MAX_MESSAGES +
      " messages."
    );
  }

  // IMAGE EXTRACTION

  const { images, question } =
    extractImageBlocks(messages);

  if (images.length > DAILY_IMAGE_LIMIT) {
    return fail(
      res,
      400,
      "You can upload up to 15 images in one request."
    );
  }

  // REQUEST CANCELLATION

  const controller = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  // NORMAL TEXT REQUEST

  if (images.length === 0) {
    const history = makeTextHistory(messages, system);

    if (!history.some(message => message.role === "user")) {
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

  // RESERVE DAILY IMAGE ANALYSIS ALLOWANCE

  let usage;

  try {
    const visitorId = getVisitorId(req, res);

    usage = await reserveImages(
      visitorId,
      images.length
    );

  } catch {
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

  // PROCESS IMAGE REQUEST

  try {
    const history = makeTextHistory(
      messages,
      system,
      true
    );

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
          " images.\n\n" +
          "Here are the analysis results from all image batches:\n\n" +
          findings.join("\n\n") +
          "\n\nAnswer my original request using these findings. " +
          "Combine information from all images. " +
          "Avoid repeating yourself. " +
          "Do not invent details that were not visible. " +
          "If an image is unclear, explain that limitation. " +
          "Give a complete and understandable answer.\n\n" +
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
      return fail(
        res,
        502,
        error.message || "Image processing failed."
      );
    }

    if (!res.writableEnded && !res.destroyed) {
      res.write(
        "data: " +
        JSON.stringify({
          type: "error",
          error: {
            message:
              error.message ||
              "Image processing failed."
          }
        }) +
        "\n\n"
      );

      res.end();
    }
  }
}
