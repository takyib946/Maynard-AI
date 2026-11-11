
export default {
  async fetch(request) {
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
      });

    if (request.method !== "POST") {
      return json({ error: "Only POST requests are allowed." }, 405);
    }

    const apiKey = process.env.GROQ_API_KEY;
    const model =
      process.env.GROQ_MODEL || "openai/gpt-oss-20b";

    if (!apiKey) {
      return json({ error: "Groq API key is not configured." }, 500);
    }

    try {
      const form = await request.formData();
      const message = String(form.get("message") || "").trim();
      const mode = String(form.get("mode") || "general");

      if (!message) {
        return json({ error: "Please enter a message." }, 400);
      }

      const modeInstructions = {
        general: "You are Maynard AI, a helpful multipurpose assistant. Give clear, accurate and friendly answers.",
        education: "You are Maynard AI Education, a patient tutor. Explain school subjects step by step and help students understand.",
        writing: "You are Maynard AI Writing Assistant. Help create, improve and explain written content.",
        coding: "You are Maynard AI Coding Assistant. Explain code clearly and provide practical, accurate programming help.",
        business: "You are Maynard AI Business Assistant. Help with responsible business ideas, planning and communication.",
        research: "You are Maynard AI Research Assistant. Give balanced explanations and distinguish known facts from uncertainty."
      };

      let userMessage = message;
      let totalSize = 0;
      const files = form.getAll("files");

      if (files.length > 5) {
        return json({ error: "Please attach no more than 5 files." }, 400);
      }

      for (const file of files) {
        if (!file || typeof file.text !== "function") continue;

        totalSize += file.size;

        if (totalSize > 4 * 1024 * 1024) {
          return json({ error: "Attachments must be under 4 MB in total." }, 400);
        }

        const name = file.name || "attachment";
        const extension = name.split(".").pop().toLowerCase();

        const allowed = ["txt", "md", "csv", "tsv"];

        if (!allowed.includes(extension)) {
          return json({
            error: "This version supports TXT, MD, CSV and TSV attachments. Other file types are not supported yet."
          }, 400);
        }

        const content = await file.text();
        userMessage += `\n\nAttachment: ${name}\n${content.slice(0, 20000)}`;
      }

      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content: modeInstructions[mode] || modeInstructions.general
              },
              {
                role: "user",
                content: userMessage
              }
            ],
            max_completion_tokens: 1500
          })
        }
      );

      const result = await response.json();

      if (!response.ok) {
        console.error("Groq API error:", result);
        return json({
          error: result.error?.message || "Groq could not complete your request."
        }, response.status);
      }

      const reply = result.choices?.[0]?.message?.content;

      if (!reply) {
        return json({ error: "The AI returned an empty response." }, 502);
      }

      return json({ reply });

    } catch (error) {
      console.error("Maynard AI error:", error);
      return json({
        error: "Maynard AI encountered a problem. Please try again."
      }, 500);
    }
  }
};
