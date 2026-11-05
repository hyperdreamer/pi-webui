import { expect, it } from "vitest";
import { normalizeBrowserOrigin } from "./browserOrigins.js";

it.each([
  ["HTTPS://PI.EXAMPLE:443/", "https://pi.example"],
  ["http://PI.EXAMPLE:80", "http://pi.example"],
  ["https://pi.example:8443", "https://pi.example:8443"],
  ["http://[::1]:8808/", "http://[::1]:8808"],
  ["https://bücher.example", "https://xn--bcher-kva.example"],
  [" https://pi.example/ ", "https://pi.example"],
] as const)("normalizes %s", (input, expected) => {
  expect(normalizeBrowserOrigin(input)).toBe(expected);
});

it.each([
  "null",
  "",
  "*",
  "/relative",
  "//host",
  "file://host",
  "https://u:p@host",
  "https://@host",
  "https://host/a",
  "https://host/a/..",
  "https://host//",
  "https://host?q=1",
  "https://host?",
  "https://host#part",
  "https://host#",
  "https://host\\",
  "https://ho st",
  "https://ho\tst",
  "https://ho\nst",
  "https://a,https://b",
  "https://a https://b",
  "http://host:99999",
  "http://host:bad",
  "http:///host",
  "https://*.example",
])("rejects %s", (input) => {
  expect(normalizeBrowserOrigin(input)).toBeUndefined();
});
