import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { projectStorePath } from "./projectStore.js";

describe("projectStorePath", () => {
  it("uses PI_WEBUI_DATA_DIR by default", () => {
    expect(projectStorePath({ PI_WEBUI_DATA_DIR: "demo-data" }, "/tmp/pi-webui")).toBe(resolve("/tmp/pi-webui", "demo-data", "projects.json"));
  });

  it("uses PI_WEBUI_PROJECTS_FILE when configured", () => {
    expect(projectStorePath({ PI_WEBUI_PROJECTS_FILE: "demo/projects.json" }, "/tmp/pi-webui")).toBe(resolve("/tmp/pi-webui", "demo/projects.json"));
  });
});
