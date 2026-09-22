import { afterEach, test, expect } from "bun:test";
import { createKiroAdapter as createKiroAdapterProduction, parseKiroStream } from "../../../src/adapters/kiro";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const createKiroAdapter = (...args: Parameters<typeof createKiroAdapterProduction>) =>
  withTestTranslatorBudget(createKiroAdapterProduction(...args));
const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as OcxProviderConfig;
const bashTool = { name: "bash", description: "Run a shell command", parameters: { type: "object" } };
function parsedWith(messages: unknown[], tools?: unknown[]): OcxParsedRequest {
  return { modelId: "claude-sonnet-4.5", stream: true, options: {}, context: { messages, tools } } as OcxParsedRequest;
}
const eventFrame = (obj: unknown) => encodeMessage(
  { ":message-type": "event", ":event-type": "assistantResponseEvent" },
  new TextEncoder().encode(JSON.stringify(obj)),
);
function streamOf(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index < frames.length) controller.enqueue(frames[index++]);
    else controller.close();
  } });
}
async function collectAdapterEvents(events: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const result: AdapterEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
  test("fallback HTTP errors stop reading oversized upstream bodies", async () => {
    const chunk = new TextEncoder().encode("A".repeat(32 * 1024));
    let pulls = 0;
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }), {
      status: 400,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "do it" }], [bashTool]));

    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "I am checking." }),
    ))));

    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      status: 400,
      retryable: false,
    });
  });

  test("fallback error-body cancellation releases the reader and turn budget without another send", async () => {
    const controller = new AbortController();
    const reason = new Error("fixture request cancelled");
    const budget = createTranslatorBudget();
    let cancelled = false;
    let sends = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() { queueMicrotask(() => controller.abort(reason)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    let caught: unknown;
    try {
      await collectAdapterEvents(parseKiroStream(
        new Response(streamOf(eventFrame({ content: "I am checking." }))),
        budget, "claude-sonnet-4.5", 0, undefined, undefined, "cancelled-turn", "required",
        async () => {
          sends++;
          return {
            response: new Response(body, { status: 400 }), abortSignal: controller.signal,
            inputTokens: 0, contextInputEstimate: 0, nameMap: new Map(), conversationId: "cancelled-turn",
          };
        },
      ));
    } catch (error) { caught = error; }
    expect(caught).toBe(reason);
    expect(sends).toBe(1);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
    expect(budget.snapshot().currentBytes).toBe(0);
  });
