import { randomUUID } from "node:crypto";

// ============================================
// MAYNARD AI
// Groq + Stability AI + Upstash Redis
// API-Football + Saved Conversation History
// Vertical Formatting + Diagrams
// ============================================

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
const MAX_BODY_BYTES = 15 * 1024 * 1024;

const ALLOWED_ACTIONS = new Set([
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

// ============================================
// MAYNARD AI SYSTEM INSTRUCTIONS
// ============================================

const MAYNARD_SYSTEM_PROMPT = `
You are MAYNARD AI, created by David Takyi.

You are a helpful, intelligent, accurate and educational
AI assistant.

STRICT ANSWER FORMATTING:

1. Write answers naturally from top to bottom.
2. Never use Markdown tables.
3. Never arrange information into columns.
4. Never use vertical divider lines.
5. Never use bordered table layouts.
6. Never use spreadsheet-style formatting.
7. Never put calculations side by side.
8. Never use unnecessary horizontal separator lines.
9. Do not use --- or *** as section separators.
10. Use headings, paragraphs and numbered steps instead.
11. Keep answers clean, readable and continuous.
12. Present information vertically, one item after another.

MATHEMATICS:

1. Explain mathematical problems step by step.
2. Write every calculation vertically.
3. Put each equation on its own line.
4. Use proper LaTeX mathematical notation.
5. Use ( ... ) for inline equations.
6. Use [ ... ] for displayed equations.
7. Explain formulas before substituting values.
8. Show important calculations clearly.
9. Present final answers clearly.
10. Include verification when useful.
11. Use graphs or diagrams when they genuinely help.
12. Never put mathematical working inside tables.

DIAGRAMS AND FLOWCHARTS:

1. Include diagrams when they improve understanding.
2. Use Mermaid diagrams for flowcharts and processes.
3. Put Mermaid diagrams inside fenced mermaid code blocks.
4. Use labelled diagrams where appropriate.
5. Use simple text diagrams when suitable.
6. Never use tables as substitutes for diagrams.
7. Keep diagrams readable and properly labelled.
8. Do not force diagrams into unrelated answers.

GENERAL RESPONSE STYLE:

- Be clear, accurate and educational.
- Avoid unnecessary repetition.
- Use examples when helpful.
- Explain difficult concepts in simple language.
- Never use tables, columns or vertical borders.
- Do not sacrifice accuracy for shorter answers.
- Do not invent facts.

IDENTITY:

If asked your name, respond:
"I am MAYNARD AI, created by David Takyi."
`;

// ============================================
// RESPONSE HELPERS
// ============================================

function send(res, status, data) {
return res.status(status).json(data);
}

function errorMessage(error) {
return error instanceof Error
? error.message
: "An unexpected server error occurred.";
}

// ============================================
// TABLE AND SEPARATOR CLEANER
// Converts Markdown tables into vertical text.
// ============================================

function cleanAIResponse(text) {
if (typeof text !== "string") {
return "";
}

const lines = text.split("\n");
const output = [];

let insideCode = false;

function parseCells(line) {
return line
.trim()
.replace(/^|/, "")
.replace(/|$/, "")
.split("|")
.map((cell) => cell.trim());
}

function isTableSeparator(line) {
return /^\s*|?\s*:?-{3,}:?\s*(|\s*:?-{3,}:?\s*)+|?\s*$/.test(
line
);
}

function isTableRow(line) {
return (
line.includes("|") &&
line.trim().length > 0
);
}

for (let i = 0; i < lines.length; i++) {
const line = lines[i];

// Preserve code blocks exactly.
if (/^\s*```/.test(line)) {
insideCode = !insideCode;
output.push(line);
continue;
}

if (insideCode) {
output.push(line);
continue;
}

// Detect a Markdown table separator.
if (
isTableSeparator(line) &&
output.length > 0 &&
isTableRow(output[output.length - 1])
) {
const headers = parseCells(output.pop());

// Skip the Markdown separator row.
i++;

while (
i < lines.length &&
isTableRow(lines[i])
) {
const values = parseCells(lines[i]);

const formattedRow = headers    
  .map((header, index) => {    
    const value = values[index] || "";    

    if (!value) return "";    

    const label =    
      header || `Item ${index + 1}`;    

    return `**${label}:** ${value}`;    
  })    
  .filter(Boolean)    
  .join("\n");    

if (formattedRow) {    
  output.push(formattedRow);    
  output.push("");    
}    

i++;

}

// Reprocess the first line after the table.
i--;
continue;
}

// Remove unnecessary horizontal separator lines.
if (
/^\s*(?:-{3,}|*{3,}|_{3,})\s*$/.test(line)
) {
continue;
}

output.push(line);

}

return output
.join("\n")
.replace(/\n{3,}/g, "\n\n")
.trim();
}

// ============================================
// COOKIE / VISITOR IDENTIFICATION
// ============================================

function getCookie(req, name) {
const cookieHeader = req.headers.cookie || "";

for (const part of cookieHeader.split(";")) {
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
const secure =
process.env.NODE_ENV === "production"
? "; Secure"
: "";

res.setHeader(
"Set-Cookie",
${COOKIE_NAME}=${encodeURIComponent(visitorId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${HISTORY_TTL}${secure}
);
}

function getVisitor(req, res) {
let visitorId = getCookie(req, COOKIE_NAME);

if (
!visitorId ||
!/^[a-f0-9-]{36}$/i.test(visitorId)
) {
visitorId = randomUUID();
setVisitorCookie(res, visitorId);
}

return visitorId;
}

// ============================================
// REQUEST BODY
// ============================================

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
throw new Error(
Missing environment variable: ${name}
);
}

return value.trim();
}

// ============================================
// UPSTASH REDIS
// ============================================

function historyKey(visitor, id) {
return maynard:history:${visitor}:${id};
}

function historyIndexKey(visitor) {
return maynard:history-index:${visitor};
}

async function redis(command, ...args) {
const url = requireEnv("UPSTASH_REDIS_REST_URL");
const token = requireEnv("UPSTASH_REDIS_REST_TOKEN");

const encodedArgs = args
.map((value) => encodeURIComponent(String(value)))
.join("/");

const endpoint =
${url.replace(//$/, "")}/${command} +
(encodedArgs ? /${encodedArgs} : "");

const response = await fetch(endpoint, {
method: "POST",
headers: {
Authorization: Bearer ${token},
},
});

const result = await response.json().catch(() => ({}));

if (!response.ok || result.error) {
throw new Error(
result.error ||
Redis request failed (${response.status}).
);
}

return result.result;
}

// ============================================
// MESSAGE CLEANING
// ============================================

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
...(message.imageOmitted
? { imageOmitted: true }
: {}),
}));
}

// ============================================
// SAVE CONVERSATION
// ============================================

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

const firstUserMessage = messages.find(
(message) => message.role === "user"
);

const title =
typeof body.title === "string" &&
body.title.trim()
? body.title.trim().slice(0, 100)
: existing?.title ||
firstUserMessage?.content.slice(0, 60) ||
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
key,
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

const count = Number(
await redis("ZCARD", historyIndexKey(visitor))
);

if (count > HISTORY_LIMIT) {
const oldIds = await redis(
"ZRANGE",
historyIndexKey(visitor),
0,
count - HISTORY_LIMIT - 1
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

// ============================================
// LIST CONVERSATIONS
// ============================================

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
// Skip invalid records.
}

}

return histories;
}

// ============================================
// GET ONE CONVERSATION
// ============================================

async function getHistory(visitor, id) {
if (
typeof id !== "string" ||
!/^[a-f0-9-]{36}$/i.test(id)
) {
throw new Error("Invalid conversation ID.");
}

const raw = await redis(
"GET",
historyKey(visitor, id)
);

if (!raw) return null;

try {
return JSON.parse(raw);
} catch {
throw new Error(
"Saved conversation data is invalid."
);
}
}

// ============================================
// RENAME CONVERSATION
// ============================================

async function renameHistory(visitor, id, title) {
const record = await getHistory(visitor, id);

if (!record) return null;

if (
typeof title !== "string" ||
!title.trim()
) {
throw new Error(
"A conversation title is required."
);
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

// ============================================
// DELETE ONE CONVERSATION
// ============================================

async function deleteHistory(visitor, id) {
if (
typeof id !== "string" ||
!/^[a-f0-9-]{36}$/i.test(id)
) {
throw new Error("Invalid conversation ID.");
}

await redis(
"DEL",
historyKey(visitor, id)
);

await redis(
"ZREM",
historyIndexKey(visitor),
id
);

return true;
}

// ============================================
// CLEAR ALL CONVERSATIONS
// ============================================

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

await redis(
"DEL",
historyIndexKey(visitor)
);

return true;
}

// ============================================
// IMAGE VALIDATION
// ============================================

function extractImageData(image) {
if (typeof image !== "string") {
throw new Error("Image data is missing.");
}

const match = image.match(
/^data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/
);

if (!match) {
throw new Error(
"Use a PNG, JPEG, or WEBP image."
);
}

const data = match[2];
const buffer = Buffer.from(data, "base64");

if (buffer.length > MAX_IMAGE_BYTES) {
throw new Error(
"Image must be 8 MB or smaller."
);
}

return {
mimeType:
match[1] === "jpg"
? "image/jpeg"
: image/${match[1]},
data,
};
}

// ============================================
// GROQ AI CHAT
// ============================================

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
["user", "assistant"].includes(message.role)
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

if (
!messages.length &&
typeof body.message === "string"
) {
messages.push({
role: "user",
content: body.message.slice(0, 20000),
});
}

if (!messages.length) {
throw new Error(
"Enter a message before sending."
);
}

// Server-controlled assistant instructions.
const chatMessages = [
{
role: "system",
content: MAYNARD_SYSTEM_PROMPT,
},
...messages,
];

// Image understanding.
if (body.image) {
const image = extractImageData(body.image);

const visionModel =
process.env.GROQ_VISION_MODEL || model;

let lastUserIndex = -1;

for (
let i = chatMessages.length - 1;
i >= 0;
i--
) {
if (chatMessages[i].role === "user") {
lastUserIndex = i;
break;
}
}

if (lastUserIndex === -1) {
throw new Error(
"An image needs a user message."
);
}

const previousContent =
chatMessages[lastUserIndex].content;

chatMessages[lastUserIndex] = {
role: "user",
content: [
{
type: "text",
text:
typeof previousContent === "string"
? previousContent
: "Please examine this image.",
},
{
type: "image_url",
image_url: {
url: data:${image.mimeType};base64,${image.data},
},
},
],
};

return callGroq(
apiKey,
visionModel,
chatMessages
);

}

return callGroq(
apiKey,
model,
chatMessages
);
}

// ============================================
// GROQ API REQUEST
// ============================================

async function callGroq(apiKey, model, messages) {
const response = await fetch(GROQ_API_URL, {
method: "POST",
headers: {
Authorization: Bearer ${apiKey},
"Content-Type": "application/json",
},
body: JSON.stringify({
model,
messages,
temperature: 0.7,
max_tokens: 4096,
}),
});

const data = await response.json().catch(() => ({}));

if (!response.ok) {
throw new Error(
data.error?.message ||
Groq request failed (${response.status}).
);
}

const rawReply =
data.choices?.[0]?.message?.content;

if (!rawReply) {
throw new Error(
"Groq returned an empty response."
);
}

return {
reply: cleanAIResponse(rawReply),
model: data.model || model,
usage: data.usage || null,
};
}

// ============================================
// STABILITY AI IMAGE GENERATION
// ============================================

async function generateImage(body) {
const apiKey = requireEnv("STABILITY_API_KEY");

const prompt =
typeof body.prompt === "string"
? body.prompt.trim().slice(0, 4000)
: "";

if (!prompt) {
throw new Error(
"Enter an image generation prompt."
);
}

const form = new FormData();

form.append("prompt", prompt);
form.append("output_format", "png");

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
form.append(
"aspect_ratio",
body.aspectRatio
);
}

const response = await fetch(STABILITY_API_URL, {
method: "POST",
headers: {
Authorization: Bearer ${apiKey},
Accept: "image/*",
},
body: form,
});

if (!response.ok) {
const errorText = await response.text();

throw new Error(
Stability AI failed (${response.status}): ${errorText.slice(0, 500)}
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
image:
data:image/png;base64,${imageBuffer.toString("base64")},
format: "png",
};
}

// ============================================
// LIVE FOOTBALL
// ============================================

async function liveFootball() {
const apiKey = requireEnv("FOOTBALL_API_KEY");

const response = await fetch(
${FOOTBALL_API_URL}?live=all,
{
headers: {
"x-apisports-key": apiKey,
},
}
);

const data = await response.json().catch(() => ({}));

if (!response.ok || data.errors?.length) {
throw new Error(
JSON.stringify(
data.errors ||
"Football API request failed."
)
);
}

return {
fixtures: (data.response || []).map((item) => ({
league: item.league?.name || "Competition",
home: item.teams?.home?.name || "Home",
away: item.teams?.away?.name || "Away",
homeGoals: item.goals?.home ?? null,
awayGoals: item.goals?.away ?? null,
status: item.fixture?.status?.long || "Unknown",
elapsed: item.fixture?.status?.elapsed ?? null,
})),
results: data.results || 0,
};
}

// ============================================
// MAIN VERCEL API HANDLER
// ============================================

export default async function handler(req, res) {
res.setHeader("Cache-Control", "no-store");

if (req.method !== "POST") {
return send(res, 405, {
success: false,
error: "Method not allowed. Use POST.",
});
}

try {
const body = await readBody(req);
const action = body.action;

if (!ALLOWED_ACTIONS.has(action)) {
return send(res, 400, {
success: false,
error: "Unknown or missing action.",
});
}

const visitor = getVisitor(req, res);

switch (action) {

// ======================================
// AI CHAT
// ======================================

case "chat": {
const result = await groqChat(body);

return send(res, 200, {    
  success: true,    
  ...result,    
});

}

// ======================================
// SAVE HISTORY
// ======================================

case "history_save": {
const record = await saveHistory(
visitor,
body
);

return send(res, 200, {    
  success: true,    
  id: record.id,    
  history: record,    
});

}

// ======================================
// LIST HISTORY
// ======================================

case "history_list": {
const histories = await listHistory(visitor);

return send(res, 200, {    
  success: true,    
  items: histories,    
  histories,    
});

}

// ======================================
// OPEN HISTORY
// ======================================

case "history_get": {
const history = await getHistory(
visitor,
body.id
);

if (!history) {    
  return send(res, 404, {    
    success: false,    
    error: "Conversation not found.",    
  });    
}    

return send(res, 200, {    
  success: true,    
  id: history.id,    
  title: history.title,    
  messages: history.messages,    
  createdAt: history.createdAt,    
  updatedAt: history.updatedAt,    
  history,    
});

}

// ======================================
// RENAME HISTORY
// ======================================

case "history_rename": {
const history = await renameHistory(
visitor,
body.id,
body.title
);

if (!history) {    
  return send(res, 404, {    
    success: false,    
    error: "Conversation not found.",    
  });    
}    

return send(res, 200, {    
  success: true,    
  history,    
});

}

// ======================================
// DELETE HISTORY
// ======================================

case "history_delete": {
await deleteHistory(
visitor,
body.id
);

return send(res, 200, {    
  success: true,    
  message: "Conversation deleted.",    
});

}

// ======================================
// CLEAR HISTORY
// ======================================

case "history_clear": {
await clearHistory(visitor);

return send(res, 200, {    
  success: true,    
  message: "Conversation history cleared.",    
});

}

// ======================================
// IMAGE GENERATION
// ======================================

case "image_generate": {
const result = await generateImage(body);

return send(res, 200, {    
  success: true,    
  ...result,    
});

}

// ======================================
// LIVE FOOTBALL
// ======================================

case "football_live": {
const result = await liveFootball();

return send(res, 200, {    
  success: true,    
  ...result,    
});

}

default:
return send(res, 400, {
success: false,
error: "Unsupported action.",
});
}

} catch (error) {
console.error(
"MAYNARD AI API error:",
error
);

return send(res, 500, {
success: false,
error: errorMessage(error),
});

}
}
