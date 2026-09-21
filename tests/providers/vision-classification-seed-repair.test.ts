import { describe, expect, test } from "bun:test";
import { projectStartupConfigRepairs } from "../../src/providers/model-rename-startup";
import { requiresVisionPreprocessing } from "../../src/vision/plan";
import type { OcxConfig } from "../../src/types";

const MODEL = "deepseek-v4.1-flash";

function configuredPolicy(modalities: string[], noVisionModels: string[]): OcxConfig {
  return {
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: "https://opencode.ai/zen/go/v1",
        modelInputModalities: { [MODEL]: modalities },
        noVisionModels,
      },
    },
  } as OcxConfig;
}

describe("startup vision classification preservation", () => {
  test("preserves an explicit text-only policy", () => {
    const config = configuredPolicy(["text"], [MODEL]);
    const projection = projectStartupConfigRepairs(config);
    const provider = projection.config.providers["opencode-go"]!;

    expect(projection.changed).toBe(false);
    expect(provider.modelInputModalities?.[MODEL]).toEqual(["text"]);
    expect(provider.noVisionModels).toContain(MODEL);
    expect(requiresVisionPreprocessing(projection.config, provider, MODEL, "opencode-go")).toBe(true);
  });

  test("preserves an explicit noVisionModels policy beside native modalities", () => {
    const config = configuredPolicy(["text", "image"], [MODEL]);
    const projection = projectStartupConfigRepairs(config);
    const provider = projection.config.providers["opencode-go"]!;

    expect(projection.changed).toBe(false);
    expect(provider.modelInputModalities?.[MODEL]).toEqual(["text", "image"]);
    expect(provider.noVisionModels).toContain(MODEL);
    expect(requiresVisionPreprocessing(projection.config, provider, MODEL, "opencode-go")).toBe(true);
  });
});
