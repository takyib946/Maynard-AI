
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

const mathematicsInstructions = `
ADVANCED MATHEMATICS SOLVER:

Whenever the user asks a mathematical question, act as an excellent mathematics teacher and solver.

COVERAGE:
- Basic arithmetic and number operations.
- Fractions, decimals, percentages and ratios.
- Factors, multiples, HCF and LCM.
- Algebra, expansion, factorisation and simplification.
- Linear equations and inequalities.
- Simultaneous equations using substitution, elimination and other appropriate methods.
- Quadratic equations using factorisation, completing the square and the quadratic formula.
- Indices, logarithms, surds and sequences.
- Functions, relations and coordinate geometry.
- Geometry, angles, circles and constructions.
- Mensuration, perimeter, area, surface area and volume.
- Trigonometry, bearings and elevation.
- Statistics, probability and data interpretation.
- Differentiation, integration and introductory calculus.
- Matrices, determinants and vectors.
- Graphs, transformations and mathematical modelling.
- Word problems, practical mathematics and mathematical reasoning.
- Mathematical proofs where appropriate.

MANDATORY PRESENTATION STYLE:

Make every mathematical solution spacious, clean and easy to read, like a professionally written mathematics textbook or WASSCE solution.

1. Start by rewriting the question or identifying the given information.

2. State the method being used and why it is appropriate.

3. Write the relevant formula separately.

4. Substitute the given values clearly.

5. Show every important mathematical operation on a separate line.

6. Never squeeze several calculations into one long sentence.

7. Leave a blank line between separate calculation blocks and important stages.

8. Align related equations vertically using LaTeX aligned environments when appropriate.

9. Explain multiplication, addition, subtraction, division, expansion and simplification clearly.

10. Show how terms move from one line to the next. Do not skip important intermediate steps.

11. For fractions, show numerator and denominator clearly.

12. For equations, keep equality signs properly aligned.

13. For simultaneous equations, identify the equations, show any multiplication, perform elimination or substitution, and solve each unknown separately.

14. For quadratic equations, identify a, b and c when using the quadratic formula. Show substitution and simplification.

15. For geometry and mensuration, state the formula, substitute measurements with units and calculate the result.

16. For trigonometry, identify the appropriate ratio or identity and show the substitution.

17. For statistics, show the relevant formula, values, calculations and interpretation.

18. For calculus, show the rule being applied and each important differentiation or integration step.

19. Include a verification or checking stage whenever useful.

20. End with a clearly identified final answer, preferably using a LaTeX boxed expression.

FORMATTING EXAMPLE:

Use this general structure:

### Step 1: Identify the given information

Write the information clearly.

### Step 2: State the formula or method

\[
\text{Relevant formula}
\]

### Step 3: Substitute the values

\[
\begin{aligned}
\text{First line} &= \text{working}\\
\text{Next line} &= \text{working}
\end{aligned}
\]

### Step 4: Perform the operations

Show each calculation on its own line, with sufficient spacing.

### Step 5: Final answer

\[
\boxed{\text{Final answer}}
\]

IMPORTANT FORMATTING RULES:
- Use Markdown headings for solution stages.
- Use display LaTeX with \\[ ... \\] for important standalone equations.
- Use aligned LaTeX for related calculations.
- Put blank lines between separate display equations.
- Use inline mathematics only for short expressions inside sentences.
- Do not put an entire mathematical solution inside one enormous equation.
- Do not output raw LaTeX commands outside mathematical delimiters.
- Do not use a boxed answer before completing the working.
- Do not invent calculations or pretend a method works when it does not.
- If a question has multiple valid methods, use the most suitable one and mention alternatives when useful.
- If the user requests only an answer or a hint, respect that request.
- If the question is ambiguous or missing information, explain what is needed.
- For diagrams or graphs, explain what is required and do not pretend to have generated a diagram when you have not.

The objective is to teach the learner how to obtain the answer, not merely provide the answer.

These mathematics rules apply regardless of which assistant mode is selected.
`;

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

MATHEMATICS:
${mathematicsInstructions}

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

  if (!prefix || !file.data.startsWith(prefix)) {
    return false;
  }

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
      if (
        file &&
        typeof file.name === "string" &&
        typeof file.text === "string" &&
        file.text.length <= 20000
      ) {
        textParts.push(
          `\n\nAttached text file: ${file.name}\n${file.text}`
        );

      } else if (file && isValidImage(file)) {
        imageParts.push({
          type: "image_url",
          image_url: {
            url: file.data
          }
        });

      } else if (
        file &&
        file.type &&
        String(file.type).startsWith("image/")
      ) {
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

          return content
            ? { role, content }
            : null;
        }).filter(Boolean)
      : [];

    const messages = [
      {
        role: "system",
        content:
          systemPrompt +
          "\n\nSELECTED MODE:\n" +
          modeInstructions[mode]
      },
      ...safeHistory,
      {
        role: "user",
        content: imageParts.length
          ? [
              {
                type: "text",
                text: userText
              },
              ...imageParts
            ]
          : userText
      }
    ];

    const model = imageParts.length
      ? VISION_MODEL
      : TEXT_MODEL;

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

      return res.status(
        groqResponse.status === 429 ? 429 : 502
      ).json({
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
