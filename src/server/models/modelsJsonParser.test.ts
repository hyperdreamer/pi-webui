import { describe, expect, it } from "vitest";
import {
  ModelsJsonParseError,
  parseModelsJsonText,
  stripModelsJsonBom,
  stripModelsJsonComments,
} from "./modelsJsonParser";

describe("Pi-compatible models.json parser", () => {
  it("strips a leading BOM only", () => {
    expect(stripModelsJsonBom("\uFEFF{}")).toBe("{}");
    expect(stripModelsJsonBom("{}")).toBe("{}");
  });

  it("strips line comments outside string literals without touching string content", () => {
    expect(stripModelsJsonComments('{ // note\n "a": "http://x//y", // tail\n "b": 1\n}'))
      .toBe('{ \n "a": "http://x//y", \n "b": 1\n}');
  });

  it("removes trailing commas before objects and arrays including newlines", () => {
    expect(stripModelsJsonComments('{"a": [1, 2,],}')).toBe('{"a": [1, 2]}');
    expect(stripModelsJsonComments('{"a": [\n1,\n2,\n],\n}')).toBe('{"a": [\n1,\n2\n]\n}');
  });

  it("parses BOM, comments, and trailing commas like Pi 0.87.1", () => {
    const text = '\uFEFF{ // provider list\n "providers": { "acme": { "models": [{ "id": "demo", },], }, },\n}';
    expect(parseModelsJsonText(text)).toEqual({ providers: { acme: { models: [{ id: "demo" }] } } });
  });

  it("keeps comment markers and escaped quotes inside strings", () => {
    expect(parseModelsJsonText('{"url": "https://example.test/a//b", "quote": "say \\"hi\\" // now"}'))
      .toEqual({ url: "https://example.test/a//b", quote: 'say "hi" // now' });
  });

  it("lets JSON.parse last-key-wins semantics apply to duplicate keys", () => {
    expect(parseModelsJsonText('{"id": "first", "id": "second"}')).toEqual({ id: "second" });
  });

  it("rejects block comments, hash comments, and non-JSON syntax with ModelsJsonParseError", () => {
    expect(() => parseModelsJsonText('{"a": 1 /* comment */}')).toThrow(ModelsJsonParseError);
    expect(() => parseModelsJsonText('# comment\n{"a": 1}')).toThrow(ModelsJsonParseError);
    expect(() => parseModelsJsonText("{a: 1}")).toThrow(ModelsJsonParseError);
    expect(() => parseModelsJsonText('{"a": 1,,}')).toThrow(ModelsJsonParseError);
  });

  it("preserves the original JSON.parse message on the wrapped error", () => {
    expect(() => parseModelsJsonText('{"a": }')).toThrow(/Unexpected|Expected|position/);
  });
});
