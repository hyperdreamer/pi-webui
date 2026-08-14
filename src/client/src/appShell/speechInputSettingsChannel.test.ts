import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechInputSettingsChannel, type SpeechInputSettingsBroadcastChannel } from "./speechInputSettingsChannel";

class FakeBroadcastChannel implements SpeechInputSettingsBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];

  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly messages: unknown[] = [];
  close = vi.fn();

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message });
  }
}

function channel(onRevision = vi.fn(), appUrl = () => "https://pi.example.test/pi-webui/"): SpeechInputSettingsChannel {
  return new SpeechInputSettingsChannel(onRevision, {
    resolveAppUrl: appUrl,
    createBroadcastChannel: (name) => new FakeBroadcastChannel(name),
  });
}

beforeEach(() => {
  FakeBroadcastChannel.instances = [];
});

describe("SpeechInputSettingsChannel", () => {
  it("derives isolated names for root and nested application bases", () => {
    channel(vi.fn(), () => "https://pi.example.test/");
    channel(vi.fn(), () => "https://pi.example.test/nested/pi-webui/");

    expect(FakeBroadcastChannel.instances.map((instance) => instance.name)).toEqual([
      "pi-webui:speech-input-settings:https://pi.example.test/",
      "pi-webui:speech-input-settings:https://pi.example.test/nested/pi-webui/",
    ]);
  });

  it("publishes only the versioned revision contract", () => {
    const subject = channel();
    const instance = requiredChannel(0);

    subject.publish("00000000-0000-4000-8000-000000000002");

    expect(instance.messages).toEqual([{
      contractVersion: 1,
      revision: "00000000-0000-4000-8000-000000000002",
    }]);
  });

  it("ignores self, same, and invalid messages", () => {
    const onRevision = vi.fn();
    const subject = channel(onRevision);
    const instance = requiredChannel(0);
    const revision = "00000000-0000-4000-8000-000000000002";

    subject.publish(revision);
    instance.emit({ contractVersion: 1, revision });
    instance.emit({ contractVersion: 2, revision: "00000000-0000-4000-8000-000000000003" });
    instance.emit({ contractVersion: 1, revision: 3 });
    instance.emit({ revision: "00000000-0000-4000-8000-000000000003" });
    instance.emit(null);

    expect(onRevision).not.toHaveBeenCalled();
  });

  it("ignores malformed nonempty UUID revisions at both boundaries", () => {
    const onRevision = vi.fn();
    const subject = channel(onRevision);
    const instance = requiredChannel(0);

    subject.publish("not-a-uuid");
    instance.emit({ contractVersion: 1, revision: "not-a-uuid" });

    expect(instance.messages).toEqual([]);
    expect(onRevision).not.toHaveBeenCalled();
  });

  it("forwards each valid foreign revision until closed", () => {
    const onRevision = vi.fn();
    const subject = channel(onRevision);
    const instance = requiredChannel(0);

    instance.emit({ contractVersion: 1, revision: "00000000-0000-4000-8000-000000000002" });
    instance.emit({ contractVersion: 1, revision: "00000000-0000-4000-8000-000000000003" });
    subject.close();
    subject.close();
    instance.emit({ contractVersion: 1, revision: "00000000-0000-4000-8000-000000000004" });

    expect(onRevision).toHaveBeenCalledTimes(2);
    expect(onRevision.mock.calls).toEqual([
      ["00000000-0000-4000-8000-000000000002"],
      ["00000000-0000-4000-8000-000000000003"],
    ]);
    expect(instance.close).toHaveBeenCalledOnce();
    expect(instance.onmessage).toBeNull();
  });

  it("degrades when BroadcastChannel is unavailable", () => {
    const onRevision = vi.fn();
    const subject = new SpeechInputSettingsChannel(onRevision, {
      resolveAppUrl: () => "https://pi.example.test/pi-webui/",
      createBroadcastChannel: () => undefined,
    });

    subject.publish("00000000-0000-4000-8000-000000000002");
    subject.close();

    expect(onRevision).not.toHaveBeenCalled();
  });
});

function requiredChannel(index: number): FakeBroadcastChannel {
  const instance = FakeBroadcastChannel.instances[index];
  if (instance === undefined) throw new Error("Expected a fake BroadcastChannel instance");
  return instance;
}
