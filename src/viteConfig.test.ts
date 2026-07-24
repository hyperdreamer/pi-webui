import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";

describe("Vite development server", () => {
  it("uses port 8809 with strict port binding", () => {
    expect(viteConfig.server).toMatchObject({ port: 8809, strictPort: true });
  });
});
