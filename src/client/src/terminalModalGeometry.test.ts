import { describe, expect, it } from "vitest";
import { moveTerminalModal, resizeTerminalModal } from "./terminalModalGeometry";

describe("terminal modal geometry", () => {
  it("moves a terminal window by its drag delta without letting it leave the viewport", () => {
    expect(moveTerminalModal(
      { left: 100, top: 120, width: 400, height: 300 },
      { x: 800, y: -500 },
      { width: 1_000, height: 800 },
    )).toEqual({ left: 584, top: 16, width: 400, height: 300 });
  });

  it("resizes from the lower-right corner without moving the terminal's top-left corner", () => {
    expect(resizeTerminalModal(
      { left: 100, top: 120, width: 400, height: 300 },
      { x: 1_000, y: -1_000 },
      { width: 1_000, height: 800 },
    )).toEqual({ left: 100, top: 120, width: 884, height: 240 });
  });
});
