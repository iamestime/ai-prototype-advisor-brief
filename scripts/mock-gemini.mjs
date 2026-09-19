import { createServer } from "node:http";

const port = Number(process.env.MOCK_GEMINI_PORT || 9009);
const blockNames = ["summary", "what_changed", "risks", "events", "talking_points", "questions"];

function words(text, count = 16) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, count)
    .join(" ");
}

function completion(content, usage = { prompt_tokens: 120, completion_tokens: 60 }) {
  return { choices: [{ message: { role: "assistant", content } }], usage };
}

function researchBlocks(user) {
  const sectionId = /<section id="([^"]+)"/.exec(user)?.[1] || "section-1";
  const requested = blockNames.filter((name) => user.includes(`${name}\n`));
  const names = requested.length ? requested : blockNames;
  return names.map((name) => {
    if (name === "summary") {
      return {
        block: name,
        paragraphs: [
          {
            text: "The latest filing describes the company, its operating model, and recent performance.",
            citations: [sectionId],
          },
        ],
      };
    }
    if (name === "risks") {
      return {
        block: name,
        items: [
          {
            title: "Execution risk",
            severity: "medium",
            text: "The filing identifies operating risks that merit continued attention.",
            citations: [sectionId],
          },
        ],
      };
    }
    if (name === "events") return { block: name, items: [] };
    if (name === "questions") {
      return {
        block: name,
        items: [
          {
            question: "What should the client watch?",
            answer: "Watch the operating factors management discusses in the latest filing.",
            citations: [sectionId],
          },
        ],
      };
    }
    return {
      block: name,
      items: [
        {
          text: "The filing provides a current, source-linked point for the client conversation.",
          citations: [sectionId],
        },
      ],
    };
  });
}

function answerFor(body) {
  const system = String(body.messages?.find((message) => message.role === "system")?.content || "");
  const user = String(body.messages?.at(-1)?.content || "");

  if (system.includes("independent fact checker")) {
    const evidence = /<evidence[^>]*>([\s\S]*?)<\/evidence>/.exec(user)?.[1] || user;
    const quote = words(evidence);
    const ids = [...user.matchAll(/<review_claim id="([^"]+)"/g)].map((match) => match[1]);
    return JSON.stringify({
      claims: ids.map((id) => ({
        id,
        verdict: "supported",
        quote,
        reason: "The claim is supported by the cited filing passage.",
      })),
    });
  }

  if (system.includes("wealth management advisor's question")) {
    const id = /<passage id="([^"]+)"/.exec(user)?.[1] || "passage-1";
    const evidence = /<passage[^>]*>([\s\S]*?)<\/passage>/.exec(user)?.[1] || user;
    return JSON.stringify({
      answer:
        "The retrieved filing passage addresses the company's operations and recent performance.",
      citations: [id],
      quote: words(evidence),
      answerable: true,
    });
  }

  return researchBlocks(user)
    .map((block) => JSON.stringify(block, null, 2))
    .join("\n");
}

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

  if (request.url?.endsWith("/embeddings")) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        model: body.model,
        data: inputs.map((text, index) => {
          const size = String(text || "").length;
          return { object: "embedding", index, embedding: [1, size % 17, size % 11, size % 7] };
        }),
      }),
    );
    return;
  }

  const content = answerFor(body);
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < content.length; i += 53) {
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 53) } }] })}\n\n`,
      );
    }
    response.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 60 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(completion(content)));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock Gemini listening on http://127.0.0.1:${port}`);
});
