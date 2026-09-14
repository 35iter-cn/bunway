const encoder = new TextEncoder();

function chunk(delta: unknown, finish = null) {
  return encoder.encode(`data: ${JSON.stringify({
    id: "mock-1", object: "chat.completion.chunk", model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
}

Bun.serve({
  port: Number(Bun.env.PORT ?? 3102),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] });
    }
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = await req.json();
    const text = "Hello from the mock upstream.";
    const stream = new ReadableStream({
      async start(c) {
        for (const t of text.split(" ")) {
          c.enqueue(chunk({ content: t + " " }));
          await Bun.sleep(20);
        }
        c.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: "mock-1", object: "chat.completion.chunk", model: body.model,
          choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        })}\n\n`));
        c.enqueue(chunk({}, "stop"));
        c.enqueue(encoder.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});