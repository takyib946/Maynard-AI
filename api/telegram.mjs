
export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!botToken || !webhookSecret) {
    return res.status(500).json({
      error: "Telegram environment variables are missing.",
    });
  }

  if (
    req.headers["x-telegram-bot-api-secret-token"] !==
    webhookSecret
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const update = req.body;
    const message = update?.message;

    if (!message?.chat?.id || message.from?.is_bot) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const userMessage = message.text || message.caption;

    if (!userMessage) {
      return res.status(200).json({ ok: true });
    }

    await fetch(
      `https://api.telegram.org/bot${botToken}/sendChatAction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          action: "typing",
        }),
      }
    );

    const appResponse = await fetch(
  "https://maynard-ai-favor.vercel.app/api/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "chat",
          mode: "General Assistant",
          messages: [
            {
              role: "user",
              content: userMessage,
            },
          ],
        }),
      }
    );

    const result = await appResponse.json();

    const reply = result.reply || result.error ||
      "Sorry, I couldn't generate a response.";

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(reply).slice(0, 4000),
        }),
      }
    );

    if (!telegramResponse.ok) {
      throw new Error("Telegram could not deliver the reply.");
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error);

    return res.status(500).json({
      error: "Telegram message processing failed.",
    });
  }
}
