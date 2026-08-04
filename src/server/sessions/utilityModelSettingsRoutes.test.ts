import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { UtilityModelSettingsResponse, UtilityModelSettingsUpdate } from "../../shared/apiTypes";
import { FEDERATED_HTTP_ROUTES } from "../../shared/federatedRoutes";
import type { UtilityModelSettingsRouteService } from "./utilityModelSettingsRoutes";
import { registerUtilityModelSettingsRoutes } from "./utilityModelSettingsRoutes";

let app: FastifyInstance;
let service: UtilityModelSettingsRouteService;
let inspectMock: MockInstance<() => Promise<UtilityModelSettingsResponse>>;
let updateMock: MockInstance<(patch: UtilityModelSettingsUpdate) => Promise<UtilityModelSettingsResponse>>;

beforeEach(() => {
  app = Fastify({ logger: false });
  service = {
    inspect: () => Promise.resolve(snapshot()),
    update: (patch) => Promise.resolve(snapshot({ settings: settingsAfter(patch) })),
  };
  inspectMock = vi.spyOn(service, "inspect");
  updateMock = vi.spyOn(service, "update");
  registerUtilityModelSettingsRoutes(app, service);
});

afterEach(async () => {
  await app.close();
});

describe("utility model settings routes", () => {
  it("returns the service snapshot unchanged from GET", async () => {
    const expected = snapshot();
    inspectMock.mockResolvedValueOnce(expected);

    const response = await app.inject({ method: "GET", url: "/utility-models" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(inspectMock).toHaveBeenCalledOnce();
  });

  it("normalizes exact references and preserves own-property null clears for PUT", async () => {
    const update = {
      lightweight: null,
      context: { provider: "acme", id: "large" },
    } satisfies UtilityModelSettingsUpdate;
    const confirmed = snapshot({ settings: { context: { provider: "acme", id: "large" } } });
    updateMock.mockResolvedValueOnce(confirmed);

    const response = await app.inject({
      method: "PUT",
      url: "/utility-models",
      payload: { settings: update },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(confirmed);
    expect(updateMock).toHaveBeenCalledExactlyOnceWith(update);
  });

  for (const invalidCase of invalidRequestCases()) {
    it(`rejects ${invalidCase.name} without invoking the service`, async () => {
      const response = await app.inject({ method: "PUT", url: "/utility-models", payload: invalidCase.body });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toMatch(invalidCase.message);
      expect(updateMock).not.toHaveBeenCalled();
    });
  }

  it("maps inspection service errors to 400", async () => {
    inspectMock.mockRejectedValueOnce(new Error("catalog unavailable"));

    const response = await app.inject({ method: "GET", url: "/utility-models" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "catalog unavailable" });
  });

  it("maps update service errors to 400", async () => {
    updateMock.mockRejectedValueOnce(new Error("context utility model acme/ghost is unavailable"));

    const response = await app.inject({
      method: "PUT",
      url: "/utility-models",
      payload: { settings: { context: { provider: "acme", id: "ghost" } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "context utility model acme/ghost is unavailable" });
  });

  it("advertises both remote utility-model methods while leaving other routes unlisted", () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path === "/utility-models")).toEqual([
      { method: "GET", path: "/utility-models" },
      { method: "PUT", path: "/utility-models" },
    ]);
    expect(FEDERATED_HTTP_ROUTES).not.toContainEqual({ method: "GET", path: "/utility-model-debug" });
  });
});

interface InvalidRequestCase {
  name: string;
  body: object;
  message: RegExp;
}

function invalidRequestCases(): InvalidRequestCase[] {
  return [
    {
      name: "a non-object body",
      body: [],
      message: /Expected object body/u,
    },
    {
      name: "a missing settings field",
      body: {},
      message: /settings is required/u,
    },
    {
      name: "an unknown request field",
      body: { settings: {}, extra: true },
      message: /unknown field/u,
    },
    {
      name: "unknown utility slots",
      body: { settings: { advanced: { provider: "acme", id: "large" } } },
      message: /unknown utility model slot/u,
    },
    {
      name: "a non-object settings field",
      body: { settings: [] },
      message: /settings must be an object/u,
    },
    {
      name: "a reference missing its id",
      body: { settings: { lightweight: { provider: "acme" } } },
      message: /id/u,
    },
    {
      name: "an unknown reference field",
      body: { settings: { context: { provider: "acme", id: "large", label: "not allowed" } } },
      message: /unknown key/u,
    },
  ];
}

function settingsAfter(patch: UtilityModelSettingsUpdate) {
  return {
    ...(patch.lightweight === undefined || patch.lightweight === null ? {} : { lightweight: patch.lightweight }),
    ...(patch.context === undefined || patch.context === null ? {} : { context: patch.context }),
  };
}

function snapshot(overrides: Partial<UtilityModelSettingsResponse> = {}): UtilityModelSettingsResponse {
  return {
    contractVersion: 1,
    settings: {},
    models: [],
    slots: {
      lightweight: { valid: true },
      context: { valid: true },
    },
    valid: true,
    ...overrides,
  };
}
