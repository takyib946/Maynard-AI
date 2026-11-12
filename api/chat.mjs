
import { createHash, randomUUID } from "node:crypto";

// MAYNARD AI — Vercel + Groq + Upstash Redis
// + Gemini Image Generation + API-Football

export const config = { maxDuration: 60 };

const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1/models";
const FOOTBALL_API_URL = "https://v3.football.api-sports.io";

const TEXT_MODEL =
  process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";

const GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-lite-image";

const MAX_TOKENS = 3072;
const MAX_MESSAGES = 60;
const DAILY_IMAGE_LIMIT = 15;
const DAILY_GENERATION_LIMIT = 3;
const IMAGES_PER_BATCH = 3;
const HISTORY_MESSAGES = 8;
const MAX_GENERATION_PROMPT = 2000;
const MAX_FOOTBALL_RESULTS = 150;

const IMAGE_REQUEST_TIMEOUT = 40000;
const IMAGE_RETRY_DELAY = 1500;
const IMAGE_MAX_RETRIES = 1;
const IMAGE_LOCK_SECONDS = 60;

const ALLOWED_ASPECT_RATIOS = new Set([
  "1:1", "16:9", "21:9", "2:3", "3:2",
  "4:5", "5:4", "9:16", "9:21"
]);

// ==========================================
// MAYNARD AI RESPONSE RULES
// ==========================================

const MAYNARD_RESPONSE_RULES = `
You are Maynard AI, an intelligent, helpful and accurate AI assistant.

YOUR MAIN GOAL:
Give users accurate, useful, understandable and complete answers.
Prioritize correctness over speed and unnecessary detail.

1. ACCURACY AND RELIABILITY

- Understand the user's question before answering.
- Answer the actual question.
- Never invent facts, statistics, quotations or sources.
- Do not present guesses as confirmed facts.
- Explain uncertainty when information is incomplete.
- Check calculations and logical conclusions.
- Correct mistakes when identified.
- Never pretend to have checked information or performed an action you have not performed.
- Do not claim information is current if it has not been verified.

2. ANSWER FORMATTING

- Use clear, natural paragraphs.
- Use headings when helpful.
- Use numbered steps for procedures and multi-step explanations.
- Use bullet points for lists.
- Avoid unnecessary tables.
- Do not use tables unless the user explicitly requests one.
- Keep answers focused on the question.
- Avoid unnecessary repetition.
- Explain technical terms in understandable language.

3. MATHEMATICS

- Support arithmetic, algebra, geometry, trigonometry, calculus and statistics.
- Use accurate mathematical notation.
- Use LaTeX for mathematical expressions.
- Use \\( ... \\) for inline mathematics.
- Use \\[ ... \\] for displayed mathematics.
- Show important calculations step by step.
- Explain why important operations are performed.
- Check arithmetic and algebraic results.
- Verify answers by substitution when possible.
- Clearly identify the final answer.
- Never put an entire mathematical solution inside a table.

4. SCIENCE AND TECHNICAL SUBJECTS

- Explain scientific concepts accurately.
- Use correct terminology and units.
- Distinguish facts from estimates and hypotheses.
- Explain formulas and their symbols.
- Never invent experimental results or evidence.

5. EDUCATION

- Answer each part of a question.
- Explain difficult concepts in simple language.
- Show working for calculations.
- Use examples when useful.
- Respect requested answer lengths and formats.
- Avoid unrelated information.

6. WRITING AND LANGUAGE

- Use correct spelling, grammar and punctuation.
- Write naturally and clearly.
- Preserve meaning when rewriting.
- Follow the requested language and tone.
- Do not change important names or figures without a reason.

7. IMAGE UNDERSTANDING

- Examine available uploaded images carefully.
- Read visible text accurately.
- Do not invent details that cannot be seen.
- Explain when something is unclear.
- Consider all supplied images.

8. GENERAL KNOWLEDGE

- Separate facts from opinions.
- Avoid unsupported claims.
- Explain when information may be outdated.
- Give useful context without overwhelming the user.

9. CONVERSATION

- Use relevant previous messages.
- Do not ask users to repeat information already available.
- Follow user corrections.
- Do not claim to have permanent memory unless that feature is actually available.

10. FINAL QUALITY CHECK

Before answering, check:
- Did I answer the actual question?
- Is the answer accurate and understandable?
- Are calculations correct?
- Did I avoid unnecessary tables?
- Did I explain uncertainty?
- Did I cover all important parts?

Give the best accurate answer you can.
`;

// ==========================================
// BASIC HELPERS
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
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Accra",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function getGhanaDateOffset(days = 0) {
  const [year, month, day] = getGhanaDate()
    .split("-")
    .map(Number);

  const date = new Date(Date.UTC(
    year,
    month - 1,
    day + days
  ));

  return date.toISOString().slice(0, 10);
}

function secondsUntilMidnightGhana() {
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
      (nextMidnight.getTime() - Date.now()) / 1000
    )
  );
}

// ==========================================
// REDIS
// ==========================================

async function redisCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Redis is not configured.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    throw new Error("Redis request failed.");
  }

  const data = await response.json();

  if (data.error) {
    throw new Error("Redis command failed.");
  }

  return data.result;
}

// ==========================================
// IMAGE GENERATION LOCK
// ==========================================

async function acquireImageLock(visitorId) {
  const key = `maynard:image-lock:${visitorId}`;
  const token = randomUUID();

  const result = await redisCommand([
    "SET",
    key,
    token,
    "NX",
    "EX",
    String(IMAGE_LOCK_SECONDS)
  ]);

  return result === "OK" ? { key, token } : null;
}

async function releaseImageLock(lock) {
  if (!lock) return;

  try {
    await redisCommand([
      "EVAL",
      `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        end
        return 0
      `,
      "1",
      lock.key,
      lock.token
    ]);
  } catch (error) {
    console.error("Image lock release error:", error);
  }
}

// ==========================================
// REFUND FAILED GENERATION
// ==========================================

async function refundGeneration(visitorId) {
  const key =
    `maynard:generations:${visitorId}:${getGhanaDate()}`;

  try {
    await redisCommand([
      "EVAL",
      `
        local current = tonumber(redis.call("GET", KEYS[1]) or "0")

        if current > 0 then
          return redis.call("DECR", KEYS[1])
        end

        return 0
      `,
      "1",
      key
    ]);
  } catch (error) {
    console.error("Generation refund error:", error);
  }
}

// ==========================================
// USAGE RESERVATION
// ==========================================

async function reserveUsage(visitorId, amount, category, maximum) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Usage tracking is not configured.");
  }

  const key =
    `maynard:${category}:${visitorId}:${getGhanaDate()}`;

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

  if (!Array.isArray(data.result)) {
    throw new Error("Invalid usage database response.");
  }

  return {
    allowed: Number(data.result[0]) === 1,
    used: Number(data.result[1])
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
// GEMINI IMAGE GENERATION
// ==========================================

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getGeminiAspectRatio(aspectRatio) {
  // Gemini 3.1 Flash Lite Image does not list 9:21.
  // Map the existing frontend option to a supported ratio.
  if (aspectRatio === "9:21") {
    return "2:3";
  }

  return aspectRatio;
}

async function generateGeminiImage(prompt, aspectRatio) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const error = new Error(
      "Image generation is not configured. Add GEMINI_API_KEY to Vercel."
    );

    error.status = 500;
    throw error;
  }

  const endpoint =
    `${GEMINI_API_URL}/${GEMINI_IMAGE_MODEL}:generateContent`;

  for (
    let attempt = 0;
    attempt <= IMAGE_MAX_RETRIES;
    attempt++
  ) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      IMAGE_REQUEST_TIMEOUT
    );

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ["IMAGE"],
            responseFormat: {
              image: {
                aspectRatio: getGeminiAspectRatio(aspectRatio),
                imageSize: "1K"
              }
            }
          }
        })
      });

      if (!response.ok) {
        const responseText = await response.text();

        let providerMessage = "";

        try {
          const parsed = JSON.parse(responseText);

          providerMessage =
            parsed.error?.message ||
            parsed.message ||
            "";
        } catch {
          providerMessage = "";
        }

        const error = new Error(
          providerMessage ||
          "Gemini could not generate the image."
        );

        error.status = response.status;

        if (
          (response.status === 429 ||
           response.status === 503 ||
           response.status === 500) &&
          attempt < IMAGE_MAX_RETRIES
        ) {
          const retryAfter = Number(
            response.headers.get("retry-after")
          );

          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 5000)
              : IMAGE_RETRY_DELAY;

          await wait(delay);
          continue;
        }

        throw error;
      }

      const data = await response.json();

      const candidates = data.candidates || [];

      let imagePart = null;

      for (const candidate of candidates) {
        const parts = candidate.content?.parts || [];

        imagePart = parts.find(part =>
          part.inlineData?.data &&
          part.inlineData?.mimeType?.startsWith("image/")
        );

        if (imagePart) break;
      }

      if (!imagePart) {
        const blockReason =
          data.promptFeedback?.blockReason ||
          candidates[0]?.finishReason ||
          "";

        const error = new Error(
          blockReason
            ? `Gemini could not generate this image. Reason: ${blockReason}. Try changing your description.`
            : "Gemini did not return an image. Please try another description."
        );

        error.status = 422;
        throw error;
      }

      const mimeType =
        imagePart.inlineData.mimeType || "image/png";

      const imageBase64 = imagePart.inlineData.data;

      if (
        !/^image\/(png|jpeg|webp)$/i.test(mimeType) ||
        typeof imageBase64 !== "string" ||
        imageBase64.length === 0
      ) {
        const error = new Error(
          "Gemini returned an unsupported or empty image."
        );

        error.status = 502;
        throw error;
      }

      // Keep the same response format expected by index.html.
      return {
        imageData: `data:${mimeType};base64,${imageBase64}`,
        mimeType
      };

    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error(
          "Image generation took too long. Please try again."
        );

        timeoutError.status = 504;
        throw timeoutError;
      }

      throw error;

    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Gemini image generation could not be completed.");
}

// ==========================================
// IMAGE GENERATION HANDLER
// ==========================================

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
    return fail(res, 400, "Please enter a longer image description.");
  }

  if (prompt.length > MAX_GENERATION_PROMPT) {
    return fail(
      res,
      400,
      `Your image description must be ${MAX_GENERATION_PROMPT} characters or fewer.`
    );
  }

  if (!ALLOWED_ASPECT_RATIOS.has(aspectRatio)) {
    return fail(res, 400, "That image aspect ratio is not supported.");
  }

  let visitorId;
  let lock;
  let generationReserved = false;

  try {
    visitorId = getVisitorId(req, res);

    lock = await acquireImageLock(visitorId);

    if (!lock) {
      return fail(
        res,
        429,
        "An image is already being generated. Please wait for it to finish."
      );
    }

    const usage = await reserveGenerations(visitorId);

    if (!usage.allowed) {
      return fail(
        res,
        429,
        "You have reached your daily image-generation limit of 3. Your allowance resets at midnight Ghana time."
      );
    }

    generationReserved = true;

    const result = await generateGeminiImage(
      prompt,
      aspectRatio
    );

    return res.status(200).json(result);

  } catch (error) {
    console.error("Gemini image generation error:", error);

    if (generationReserved && visitorId) {
      await refundGeneration(visitorId);
    }

    const status = Number(error.status) || 502;

    let message = "Image generation failed. Please try again.";

    if (status === 400) {
      message = "Gemini rejected the image request. Check your prompt and try again.";
    } else if (status === 401 || status === 403) {
      message = "Gemini rejected the API key or the project does not have permission. Check GEMINI_API_KEY and your Google AI Studio project.";
    } else if (status === 402) {
      message = "Your Gemini API project may need billing enabled.";
    } else if (status === 404) {
      message = "The configured Gemini image model was not found. Check GEMINI_IMAGE_MODEL.";
    } else if (status === 422) {
      message = error.message;
    } else if (status === 429) {
      message = "Gemini is rate-limiting image generation or your API quota has been reached. Please wait and try again.";
    } else if (status === 503) {
      message = "Gemini image generation is temporarily unavailable.";
    } else if (status === 504) {
      message = "Image generation timed out. Please try again.";
    }

    return fail(
      res,
      status >= 400 && status <= 599 ? status : 502,
      message
    );

  } finally {
    await releaseImageLock(lock);
  }
}

// ==========================================
// IMAGE EXTRACTION
// ==========================================

function extractImageBlocks(messages) {
  const latestUser = [...messages]
    .reverse()
    .find(message => message && message.role === "user");

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

// ==========================================
// CONVERSATION HISTORY
// ==========================================

function makeTextHistory(messages, system, excludeLatestUser = false) {
  const output = [];

  const systemInstructions = [
    MAYNARD_RESPONSE_RULES,
    `
    RESPONSE FORMATTING RULES:

    - Use clear, numbered steps for tutorials.
    - Use Step 1, Step 2, Step 3 when explaining procedures.
    - Do not use tables unless the user explicitly requests one.
    - Explain mathematics line by line.
    - Show calculations clearly.
    - Use bullet points for lists.
    - Keep explanations beginner-friendly.
    `
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
// FOOTBALL
// ==========================================

function getLatestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (!message || message.role !== "user") continue;

    if (typeof message.content === "string") {
      return message.content.trim();
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter(part => part?.type === "text")
        .map(part => String(part.text || ""))
        .join("\n")
        .trim();
    }
  }

  return "";
}

function isFootballQuestion(message) {
  return /\b(football|soccer|live matches|live football|live scores?|football scores?|match scores?|fixtures?|kick.?off|premier league|champions league|la liga|serie a|bundesliga|ligue 1|afcon|black stars|ghana match|arsenal|real madrid|barcelona|manchester united|liverpool|chelsea|manchester city|inter miami|juventus|bayern|psg|football match|soccer match)\b/i.test(message);
}

async function getFootballData(path, apiKey, signal) {
  const response = await fetch(
    `${FOOTBALL_API_URL}/${path}`,
    {
      method: "GET",
      signal,
      headers: {
        "x-apisports-key": apiKey
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.errors
        ? JSON.stringify(data.errors)
        : `API-Football returned HTTP ${response.status}.`
    );
  }

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data;
}

function formatFootballMatch(match) {
  const fixture = match.fixture || {};
  const league = match.league || {};
  const teams = match.teams || {};
  const goals = match.goals || {};
  const status = fixture.status || {};

  const home = teams.home?.name || "Home team";
  const away = teams.away?.name || "Away team";

  const homeScore =
    goals.home === null || goals.home === undefined
      ? "-"
      : goals.home;

  const awayScore =
    goals.away === null || goals.away === undefined
      ? "-"
      : goals.away;

  const elapsed =
    status.elapsed !== null && status.elapsed !== undefined
      ? `${status.elapsed}'`
      : status.short || "Scheduled";

  let kickoff = "Time unavailable";

  if (fixture.date) {
    const parsedDate = new Date(fixture.date);

    if (!Number.isNaN(parsedDate.getTime())) {
      kickoff = new Intl.DateTimeFormat("en-GH", {
        timeZone: "Africa/Accra",
        dateStyle: "medium",
        timeStyle: "short"
      }).format(parsedDate);
    }
  }

  return [
    `${home} ${homeScore} - ${awayScore} ${away}`,
    `Competition: ${league.name || "Unknown competition"}`,
    `Country: ${league.country || "Unknown"}`,
    `Status: ${status.long || status.short || "Unknown"}`,
    `Match time: ${elapsed}`,
    `Ghana kickoff time: ${kickoff}`,
    `Venue: ${fixture.venue?.name || "Not provided"}`
  ].join(" | ");
}

async function getFootballContext(question, signal) {
  const apiKey = process.env.FOOTBALL_API_KEY;

  if (!apiKey) {
    return `
FOOTBALL DATA NOTICE:

The football feature is not configured.
Tell the user to add FOOTBALL_API_KEY to Vercel Environment Variables.
Do not invent live scores or fixtures.
`;
  }

  try {
    const text = question.toLowerCase();

    const wantsTomorrow =
      /\b(tomorrow|tomorrow's)\b/i.test(text);

    const wantsToday =
      /\b(today|today's|tonight)\b/i.test(text);

    let endpoint;
    let requestType;

    if (wantsTomorrow) {
      endpoint =
        `fixtures?date=${getGhanaDateOffset(1)}&timezone=Africa/Accra`;

      requestType = "Tomorrow's fixtures";

    } else if (wantsToday) {
      endpoint =
        `fixtures?date=${getGhanaDateOffset(0)}&timezone=Africa/Accra`;

      requestType = "Today's fixtures";

    } else {
      endpoint = "fixtures?live=all&timezone=Africa/Accra";
      requestType = "Worldwide live matches";
    }

    const data = await getFootballData(
      endpoint,
      apiKey,
      signal
    );

    const matches = Array.isArray(data.response)
      ? data.response
      : [];

    if (matches.length === 0) {
      return `
FOOTBALL DATA RESULTS:

The football provider returned no matches for:
${requestType}.

Explain that no matching results were returned.
Do not invent matches, teams, scores or kickoff times.
`;
    }

    const displayedMatches = matches.slice(
      0,
      MAX_FOOTBALL_RESULTS
    );

    const formattedMatches = displayedMatches.map(
      (match, index) =>
        `${index + 1}. ${formatFootballMatch(match)}`
    );

    return `
VERIFIED FOOTBALL DATA FROM API-FOOTBALL

Request type: ${requestType}
Timezone: Africa/Accra (Ghana)
Matches returned: ${matches.length}
Matches included: ${displayedMatches.length}

MATCH RESULTS:

${formattedMatches.join("\n")}

IMPORTANT:

- Use these results as the source of truth.
- Show team names, scores, competition and match status.
- Show elapsed minutes for live matches when available.
- Show Ghana kickoff times for scheduled matches.
- Do not invent missing scores, matches or times.
- Do not claim that the provider returned every match in the world.
- ${
      matches.length > displayedMatches.length
        ? "More results were returned than displayed."
        : "All results returned by this request are included."
    }
- Distinguish live matches from scheduled matches.
`;
  } catch (error) {
    if (signal?.aborted) throw error;

    console.error("API-Football error:", error);

    return `
FOOTBALL DATA UNAVAILABLE

The football data provider could not return reliable data.
Explain that football information is temporarily unavailable.
Do not guess or invent scores, fixtures or match times.
`;
  }
}

// ==========================================
// GROQ API
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
        "The AI service is busy or its usage limit has been reached. Please wait and try again."
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
      `AI service error (${response.status}): ` +
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

  const result = data.choices?.[0]?.message?.content;

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
    throw new Error("The AI service returned an empty response.");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const send = object => {
    if (!res.writableEnded && !res.destroyed) {
      res.write("data: " + JSON.stringify(object) + "\n\n");
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

  // IMAGE GENERATION

  if (body.action === "generate_image") {
    return handleImageGeneration(req, res);
  }

  // API KEY

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return fail(res, 500, "The server is missing GROQ_API_KEY.");
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
      `Send a non-empty messages array with a maximum of ${MAX_MESSAGES} messages.`
    );
  }

  for (const message of messages) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      !(
        typeof message.content === "string" ||
        Array.isArray(message.content)
      )
    ) {
      return fail(
        res,
        400,
        "One or more conversation messages are invalid."
      );
    }
  }

  if (
    system !== undefined &&
    typeof system !== "string"
  ) {
    return fail(res, 400, "Invalid app instructions.");
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

  // CANCELLATION

  const controller = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  // NORMAL TEXT REQUEST

  if (images.length === 0) {
    let extraInstructions =
      typeof system === "string" ? system : "";

    const latestQuestion = getLatestUserText(messages);

    if (isFootballQuestion(latestQuestion)) {
      try {
        const footballContext = await getFootballContext(
          latestQuestion,
          controller.signal
        );

        if (controller.signal.aborted) return;

        extraInstructions = [
          extraInstructions,
          footballContext
        ].filter(Boolean).join("\n\n");

      } catch (error) {
        if (controller.signal.aborted) return;

        console.error("Football integration error:", error);

        extraInstructions = [
          extraInstructions,
          "Football data could not be retrieved. Do not invent live scores or fixtures."
        ].filter(Boolean).join("\n\n");
      }
    }

    const history = makeTextHistory(
      messages,
      extraInstructions
    );

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
      if (controller.signal.aborted) return;

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

  // RESERVE IMAGE ANALYSIS ALLOWANCE

  let usage;

  try {
    const visitorId = getVisitorId(req, res);

    usage = await reserveImages(
      visitorId,
      images.length
    );

  } catch (error) {
    console.error("Image usage reservation error:", error);

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

  // PROCESS IMAGES

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

    console.error("Image processing error:", error);

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
