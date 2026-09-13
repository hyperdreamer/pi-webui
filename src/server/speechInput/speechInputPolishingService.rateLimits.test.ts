import { describe, expect, it, vi } from "vitest";
import { wrapModelCompletion } from "../rateLimits/modelRateLimitAdapters";
import { createModelRateLimitOwner } from "../rateLimits/modelRateLimitOwner";
import {
  createFakeModelRateLimitClock,
  fixtureIdentity,
  fixtureLimits,
  fixtureSnapshot,
  fixtureTerminalMessage,
} from "../rateLimits/modelRateLimit.testSupport";
import { createSpeechInputPolishingService } from "./speechInputPolishingService";

const identity = fixtureIdentity("acme", "lightweight");
const model = {
  id: "lightweight",
  name: "Lightweight",
  api: "anthropic-messages" as const,
  provider: "acme",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};

function polishedMessage(input: number) {
  const base = fixtureTerminalMessage({ api: model.api, provider: model.provider, model: model.id });
  return fixtureTerminalMessage({
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "polished text" }],
    usage: { ...base.usage, input, totalTokens: input },
  });
}

function candidateResolver() {
  return { configuredCandidates: vi.fn().mockResolvedValue([{ model, thinkingLevel: "off", slot: "lightweight" }]) };
}

describe("speech input polishing rate limit integration", () => {
  it("charges the actual candidate model through the injected completion adapter", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ acme: { lightweight: fixtureLimits(5) } }), "accepted-document");
    const completeSimple = vi.fn(() => Promise.resolve(polishedMessage(5)));
    const service = createSpeechInputPolishingService({
      modelRuntime: { completeSimple: wrapModelCompletion(owner, completeSimple) },
      utilityModelResolver: candidateResolver(),
    });

    await expect(service.polish("hello")).resolves.toBe("polished text");

    const followUp = owner.acquire(identity);
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    owner.dispose();
    await expect(followUp).resolves.toEqual({ status: "aborted" });
  });

  it("preserves the route deadline while queued and never dispatches after abort", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ acme: { lightweight: fixtureLimits(undefined, 1) } }), "accepted-document");
    const completeSimple = vi.fn(() => Promise.resolve(polishedMessage(0)));
    const service = createSpeechInputPolishingService({
      modelRuntime: { completeSimple: wrapModelCompletion(owner, completeSimple) },
      utilityModelResolver: candidateResolver(),
    });
    await owner.acquire(identity);
    const controller = new AbortController();

    const polishing = service.polish("hello", controller.signal);
    await vi.waitFor(() => { expect(owner.pendingWaiterCount(identity)).toBe(1); });
    controller.abort();

    await expect(polishing).rejects.toMatchObject({ code: "SPEECH_INPUT_POLISHING_ABORTED" });
    expect(completeSimple).not.toHaveBeenCalled();
    expect(owner.pendingWaiterCount(identity)).toBe(0);
    clock.advance(60_000);
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
