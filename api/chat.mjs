
const TEXT_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const modeInstructions = {
  general: "Help with general questions, explanations, planning and everyday tasks.",
  education: "Act as a patient tutor. Explain school subjects clearly, show every important step in worked solutions, define terms, show formulas, explain calculations and give examples. Help the learner understand rather than only giving a final answer. If a question is ambiguous, state your assumption.",
  writing: "Help create, improve and explain writing. Use clear structure, appropriate tone and correct grammar.",
  coding: "Act as a careful programming tutor. Explain the solution step by step, provide complete working code when requested, identify where files belong and explain how to test the result. Never claim code was tested unless it actually was.",
  research: "Give careful, balanced explanations. Separate established facts from uncertainty. Do not pretend to have searched the live web.",
  business: "Give practical, realistic business explanations and plans. Explain assumptions, costs and risks without guaranteeing results.",
  creative: "Help brainstorm and develop original creative ideas.",
  translator: "Translate accurately while preserving meaning, tone and context. Explain ambiguous phrases when useful.",
  summarizer: "Summarize supplied information accurately. Preserve important details and do not invent missing content."
};

const systemPrompt = `
You are Maynard AI, a helpful, patient, multilingual AI assistant.

IDENTITY:
- Your name is Maynard AI.
- Requests are processed through the Groq API.
- The default text model is ${TEXT_MODEL}.
- Do not claim to be ChatGPT, GPT-4, or an OpenAI-hosted assistant.
- If asked who provides the AI service, explain that this application uses the Groq API.

ANSWER QUALITY:
- Give useful, accurate and well-organized answers.
- Explain solutions in enough detail for the user to understand them.
- For calculations, show the formula, substitution, working and final answer.
- For school questions, explain important concepts and give examples where useful.
- For coding, explain the steps, provide complete code when requested, and identify filenames and locations.
- Use headings and numbered steps when they improve clarity.
- Use simple language without making explanations unnecessarily complicated.
- If a question has several parts, answer every part.
- If information is missing, say what is missing instead of inventing it.
- Never pretend to browse the internet, open a file, run code or perform an action that you have not performed.
- Be respectful and supportive. Adapt the level of explanation to the user's question.

CURRENT MODE:
${modeInstructions.general}

The selected mode instruction is supplied separately with each request.
`;

const requestCounts = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now - entry.start > 60000) {
    requestCounts.set(ip, { start: now, count: 1 });
    return true;
  }

  if (entry.count >= 15) return false;
  entry.count += 1;
  return true;
}

function getIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return "unknown";
}

function isValidImage(file) {
  if (!file || typeof file.data !== "string") return false;

  const allowed = {
    "image/jpeg": "data:image/jpeg;base64,",
    "image/png": "data:image/png;base64,",
    "image/webp": "data:image/webp;base64,"
  };

  const prefix = allowed[file.type];
  if (!prefix || !file.data.startsWith(prefix)) return false;

  return file.data.length <= 2800000;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      error: "Method not allowed."
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: "The AI server is not configured. Please ask the site administrator to check the server settings."
    });
  }

  if (!rateLimit(getIp(req))) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please wait a minute and try again."
    });
  }

  try {
    const body = req.body || {};
    const message = typeof body.message === "string"
      ? body.message.trim()
      : "";

    const mode = typeof body.mode === "string" &&
      Object.prototype.hasOwnProperty.call(modeInstructions, body.mode)
        ? body.mode
        : "general";

    const attachments = Array.isArray(body.attachments)
      ? body.attachments.slice(0, 5)
      : [];

    if (!message && attachments.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Please enter a message or attach a file."
      });
    }

    if (message.length > 12000) {
      return res.status(400).json({
        success: false,
        error: "Your message is too long. Please shorten it and try again."
      });
    }

    const imageParts = [];
    const textParts = [];

    for (const file of attachments) {
      if (file && typeof file.name === "string" &&
          typeof file.text === "string" &&
          file.text.length <= 20000) {
        textParts.push(
          `\n\nAttached text file: ${file.name}\n${file.text}`
        );
      } else if (file && isValidImage(file)) {
        imageParts.push({
          type: "image_url",
          image_url: { url: file.data }
        });
      } else if (file && file.type && String(file.type).startsWith("image/")) {
        return res.status(400).json({
          success: false,
          error: "An image could not be processed. Please use a JPG, PNG or WEBP image and try again."
        });
      }
    }

    const userText =
      (message || "Please examine and explain the attached image or file.") +
      textParts.join("");

    const safeHistory = Array.isArray(body.history)
      ? body.history.slice(-12).map(item => {
          const role = item && item.role === "assistant"
            ? "assistant"
            : "user";

          const content = item && typeof item.content === "string"
            ? item.content.slice(0, 6000)
            : "";

          return content ? { role, content } : null;
        }).filter(Boolean)
      : [];

    const messages = [
      {
        role: "system",
        content: systemPrompt + "\n\nSELECTED MODE:\n" +
          modeInstructions[mode]
      },
      ...safeHistory,
      {
        role: "user",
        content: imageParts.length
          ? [
              { type: "text", text: userText },
              ...imageParts
            ]
          : userText
      }
    ];

    const model = imageParts.length ? VISION_MODEL : TEXT_MODEL;

    const groqResponse = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.5,
        max_tokens: 4096
      })
    });

    const result = await groqResponse.json();

    if (!groqResponse.ok) {
      console.error("Groq API error:", result);

      return res.status(groqResponse.status === 429 ? 429 : 502).json({
        success: false,
        error: groqResponse.status === 429
          ? "The AI service is busy or its usage limit has been reached. Please try again later."
          : "The AI service could not complete your request. Please try again."
      });
    }

    const reply = result.choices?.[0]?.message?.content;

    if (!reply || typeof reply !== "string") {
      return res.status(502).json({
        success: false,
        error: "The AI service returned an empty answer. Please try again."
      });
    }

    return res.status(200).json({
      success: true,
      reply,
      model,
      mode,
      usage: result.usage || null
    });

  } catch (error) {
    console.error("Maynard AI server error:", error);

    return res.status(500).json({
      success: false,
      error: "Something went wrong on the AI server. Please try again."
    });
  }
}
