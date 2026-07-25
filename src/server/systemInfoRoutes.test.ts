import { describe, expect, it } from "vitest";
import { parseNetDevSnapshot } from "./systemInfoRoutes";

describe("parseNetDevSnapshot", () => {
  it("aggregates received and transmitted bytes across non-loopback interfaces", () => {
    const snapshot = parseNetDevSnapshot(`
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0
  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0
 wlan0: 3000 1 0 0 0 0 0 0 4000 1 0 0 0 0 0 0
`);

    expect(snapshot).toEqual({ rxBytes: 4000, txBytes: 6000 });
  });

  it("returns no snapshot when only the loopback interface is present", () => {
    expect(parseNetDevSnapshot(`
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0
`)).toBeUndefined();
  });
});
