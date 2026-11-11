
export default {
  async fetch(request) {
    const json = (data, status = 200) =>
      Response.json(data, { status });

    if (request.method !== "POST") {
      return json({ error: "Please use POST." }, 405);
    }

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return json({
        error: "AI server is not configured. Add OPENAI_API_KEY in Vercel."
      }, 500);
    }

    try {
      const form = await request.formData();

      const message = String(
        form.get("message") || ""
      ).trim();

      const mode = String(
        form.get("mode") || "General Assistant"
      ).slice(0, 80);

      const files = form.getAll("files").filter(
        file => file && typeof file.arrayBuffer === "function"
      );

      if (!message && files.length === 0) {
        return json({
          error: "Enter a message or attach a file."
        }, 400);
      }

      if (files.length > 5) {
        return json({
          error: "Maximum 5 attachments allowed."
        }, 400);
      }

      const totalSize = files.reduce(
        (total, file) => total + file.size, 0
      );

      if (totalSize > 4 * 1024 * 1024) {
        return json({
          error: "Attachments must total no more than 4 MB."
        }, 413);
      }

      const mimeTypes = {
        pdf: "application/pdf",
        txt: "text/plain",
        md: "text/markdown",
        csv: "text/csv",
        tsv: "text/tab-separated-values",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        rtf: "application/rtf"
      };

      const content = [{
        type: "input_text",
        text:
          "Maynard AI mode: " + mode +
          "\nUser message: " +
          (message || "Please analyze my attachment.")
      }];

      for (const file of files) {
        const filename = String(file.name || "attachment");
        const extension = filename.split(".").pop().toLowerCase();

        if (!file.size) {
          return json({
            error: "One of your files is empty."
          }, 400);
        }

        const bytes = Buffer.from(await file.arrayBuffer());
        const base64 = bytes.toString("base64");

        if (file.type && file.type.startsWith("image/")) {
          const allowedImages = [
            "image/jpeg",
            "image/png",
            "image/webp"
          ];

          if (!allowedImages.includes(file.type)) {
            return json({
              error: "Use JPG, PNG or WEBP images."
            }, 415);
          }

          content.push({
            type: "input_image",
            image_url: `data:${file.type};base64,${base64}`,
            detail: "auto"
          });

        } else if (mimeTypes[extension]) {
          content.push({
            type: "input_file",
            filename,
            file_data:
              `data:${mimeTypes[extension]};base64,${base64}`
          });

        } else {
          return json({
            error: "Unsupported file: " + filename
          }, 415);
        }
      }

      const aiResponse = await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-6-astra",

            instructions: `
You are Maynard AI, a helpful multipurpose AI assistant.

Your areas of assistance include:
- General questions and explanations.
- Education and learning.
- University and college assignments.
- Writing and editing.
- Programming and debugging.
- Business ideas and planning.
- Research and document analysis.
- Understanding uploaded images.

Always:
- Give clear and accurate answers.
- Use headings when helpful.
- Explain difficult ideas in simple language.
- Show calculation steps when appropriate.
- Never invent facts, sources or references.
- Say when information is uncertain.
- Help students understand their work.

For uploaded files:
- Carefully examine the available content.
- Explain relevant diagrams and questions.
- Mention if a document is unclear or unreadable.

Be helpful, respectful and natural.
`,

            input: [{
              role: "user",
              content
            }],

            max_output_tokens: 1800
          })
        }
      );

      const result = await aiResponse.json();

      if (!aiResponse.ok) {
        return json({
          error:
            result.error?.message ||
            "The AI service could not complete your request."
        }, 502);
      }

      const reply = result.output_text ||
        (result.output || [])
          .filter(item => item.type === "message")
          .flatMap(item => item.content || [])
          .filter(part => part.type === "output_text")
          .map(part => part.text)
          .join("\n");

      if (!reply) {
        return json({
          error: "The AI returned an empty response."
        }, 502);
      }

      return json({ reply });

    } catch (error) {
      return json({
        error: "Server error: " +
          (error.message || "Please try again.")
      }, 500);
    }
  }
};
