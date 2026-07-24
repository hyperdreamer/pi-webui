import { describe, expect, it } from "vitest";
import { machineBaseUrlValidationMessage, suggestedMachineNameFromUrl } from "./MachineDialog";

describe("suggestedMachineNameFromUrl", () => {
  it("suggests the host without protocol or port", () => {
    expect(suggestedMachineNameFromUrl("http://127.0.0.1:8808")).toBe("127.0.0.1");
    expect(suggestedMachineNameFromUrl("https://devbox.example.test:8808/pi-webui")).toBe("devbox.example.test");
  });

  it("also suggests a host while the URL protocol is being typed", () => {
    expect(suggestedMachineNameFromUrl("devbox.local:8808")).toBe("devbox.local");
  });
});

describe("machineBaseUrlValidationMessage", () => {
  it("accepts http and https base URLs", () => {
    expect(machineBaseUrlValidationMessage("http://127.0.0.1:8808")).toBeUndefined();
    expect(machineBaseUrlValidationMessage("https://devbox.example.test/pi-webui")).toBeUndefined();
  });

  it("explains invalid machine URLs", () => {
    expect(machineBaseUrlValidationMessage("")).toBe("Remote PI WEBUI URL is required.");
    expect(machineBaseUrlValidationMessage("devbox.local:8808")).toBe("Use an http:// or https:// URL.");
    expect(machineBaseUrlValidationMessage("ftp://devbox.example.test")).toBe("Use an http:// or https:// URL.");
    expect(machineBaseUrlValidationMessage("https://user@devbox.example.test")).toBe("Do not include credentials in the machine URL.");
    expect(machineBaseUrlValidationMessage("https://devbox.example.test?q=1")).toBe("Do not include a query string or fragment.");
  });
});
