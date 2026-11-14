
export const config = {
  maxDuration: 30,
};

const APP_URL = "https://maynard-ai-favor.vercel.app";

export default async function handler(req, res) {
  // Show a private setup page
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>MAYNARD AI Telegram Setup</title>
        <style>
          body {
            background: #101010;
            color: white;
            font-family: Arial;
            padding: 30px 15px;
          }
          main {
            max-width: 420px;
            margin: 50px auto;
            background: #202020;
            padding: 25px;
            border-radius: 15px;
          }
          input, button {
            box-sizing: border-box;
            width: 100%;
            padding: 14px;
            margin-top: 12px;
            border-radius: 8px;
            border: none;
          }
          button {
            background: #2388ff;
            color: white;
            font-weight: bold;
          }
          #result {
            overflow-wrap: anywhere;
          }
        </style>
      </head>
      <body>
        <main>
          <h2>MAYNARD AI</h2>
          <p>Secure Telegram webhook setup</p>
          <form id="setupForm">
            <input
              id="setupKey"
              type="password"
              placeholder="Enter your private setup key"
              required
              autocomplete="off"
            >
            <button type="submit">Connect Telegram Bot</button>
          </form>
          <p id="result"></p>
        </main>

        <script>
          document.getElementById("setupForm")
            .addEventListener("submit", async function(event) {
              event.preventDefault();

              const key = document.getElementById("setupKey").value;
              const result = document.getElementById("result");

              result.textContent = "Connecting...";

              try {
                const response = await fetch("/api/telegram-setup", {
                  method: "POST",
                  headers: {
                    "x-setup-key": key
                  }
                });

                const data = await response.json();

                result.textContent = data.message || data.error ||
                  "Setup finished.";

              } catch (error) {
                result.textContent = "Connection failed. Please try again.";
              }
            });
        </script>
      </body>
      </html>
    `);
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  const setupKey = process.env.TELEGRAM_SETUP_KEY;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!setupKey || !botToken || !webhookSecret) {
    return res.status(500).json({
      error: "A required Telegram environment variable is missing."
    });
  }

  if (req.headers["x-setup-key"] !== setupKey) {
    return res.status(401).json({
      error: "Incorrect setup key."
    });
  }

  try {
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: `${APP_URL}/api/telegram`,
          secret_token: webhookSecret,
          allowed_updates: ["message"]
        })
      }
    );

    const result = await telegramResponse.json();

    if (!telegramResponse.ok || !result.ok) {
      return res.status(502).json({
        error: result.description || "Telegram webhook setup failed."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Telegram webhook connected successfully!"
    });

  } catch (error) {
    console.error("Telegram setup error:", error);

    return res.status(500).json({
      error: "Could not connect to Telegram."
    });
  }
}
