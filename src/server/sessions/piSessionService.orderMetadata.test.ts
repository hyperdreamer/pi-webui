import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import {
  CapturingSessionEventHub,
  emptyArchiveStore,
  fakeRuntime,
  runtimeCreator,
  sessionGateway,
  sessionRecord,
  testModelRuntime,
} from "./piSessionService.testSupport.js";
import { SessionMetadataStore } from "./sessionMetadataStore.js";

const TEST_AGENT_DIR = "/tmp/pi-webui-test-agent";

describe("PiSessionService order metadata enrichment", () => {
  let root: string;
  let metadataPath: string;
  let service: PiSessionService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-webui-order-metadata-"));
    metadataPath = join(root, "session-metadata.json");
  });

  afterEach(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("lists only scope-and-pin-matching manual positions", async () => {
    await writeFile(metadataPath, JSON.stringify({
      "/sessions/root.jsonl": {
        order: { position: 3, scope: { kind: "root", cwd: "/workspace" }, pinned: false },
      },
      "/sessions/wrong-cwd.jsonl": {
        order: { position: 4, scope: { kind: "root", cwd: "/other" }, pinned: false },
      },
      "/sessions/wrong-pin.jsonl": {
        pinned: true,
        order: { position: 5, scope: { kind: "root", cwd: "/workspace" }, pinned: false },
      },
      "/sessions/child.jsonl": {
        order: { position: 1, scope: { kind: "children", parentSessionPath: "/sessions/parent.jsonl" }, pinned: false },
      },
      "/sessions/wrong-parent.jsonl": {
        order: { position: 2, scope: { kind: "children", parentSessionPath: "/sessions/other.jsonl" }, pinned: false },
      },
    }), "utf8");

    const metadataStore = new SessionMetadataStore(metadataPath);
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("session-1");
    const records = [
      { ...sessionRecord("root", "/workspace"), path: "/sessions/root.jsonl" },
      { ...sessionRecord("wrong-cwd", "/workspace"), path: "/sessions/wrong-cwd.jsonl" },
      { ...sessionRecord("wrong-pin", "/workspace"), path: "/sessions/wrong-pin.jsonl" },
      {
        ...sessionRecord("child", "/workspace"),
        path: "/sessions/child.jsonl",
        parentSessionPath: "/sessions/parent.jsonl",
      },
      {
        ...sessionRecord("wrong-parent", "/workspace"),
        path: "/sessions/wrong-parent.jsonl",
        parentSessionPath: "/sessions/parent.jsonl",
      },
    ];
    service = new PiSessionService(hub, {
      agentDir: TEST_AGENT_DIR,
      modelRuntime: testModelRuntime,
      createAgentRuntime: runtimeCreator(fake.runtime),
      sessionManager: sessionGateway(records),
      archiveStore: emptyArchiveStore(),
      heartbeatIntervalMs: 60_000,
      metadataStore,
    });

    const listed = await service.list("/workspace");
    expect(listed.find((session) => session.id === "root")).toMatchObject({ manualOrder: 3 });
    expect(listed.find((session) => session.id === "wrong-cwd")?.manualOrder).toBeUndefined();
    expect(listed.find((session) => session.id === "wrong-pin")).toMatchObject({ pinned: true });
    expect(listed.find((session) => session.id === "wrong-pin")?.manualOrder).toBeUndefined();
    expect(listed.find((session) => session.id === "child")).toMatchObject({ manualOrder: 1 });
    expect(listed.find((session) => session.id === "wrong-parent")?.manualOrder).toBeUndefined();
  });
});
