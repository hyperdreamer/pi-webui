import { expect, it } from "vitest";
import { fileViewKindForPath, MAX_FILE_VIEW_BYTES, MAX_FILE_VIEW_LABEL } from "./fileViewTypes.js";
import { imageMimeTypeForPath } from "../server/workspaces/imagePreviewService.js";

const kinds = {
  document: ["html", "htm", "svg"],
  pdf: ["pdf"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"],
  text: ["txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "xml", "yaml", "yml", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "py", "sh", "rs", "go", "java", "c", "h", "cc", "cpp", "hpp", "toml", "ini", "conf"],
} as const;

for (const [kind, extensions] of Object.entries(kinds)) {
  for (const ext of extensions) {
    it(`classifies .${ext} as ${kind}`, () => {
      expect(fileViewKindForPath(`a.${ext}`)).toBe(kind);
    });
  }
}

it("classifies uppercase final extensions on POSIX and Windows paths", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["/a/b.HTML", "document"],
    ["C:\\a\\b.PDF", "pdf"],
    ["a/b\\c.PNG", "image"],
    ["a/b.TSX", "text"],
  ];
  for (const [path, expected] of cases) expect(fileViewKindForPath(path)).toBe(expected);
});

it("rejects unknown, extensionless, dotfile-only, trailing-dot and directory paths", () => {
  for (const path of ["a.exe", "Makefile", ".html", "a.", "folder.html/", "folder.svg\\"]) expect(fileViewKindForPath(path)).toBeUndefined();
});

it("uses only the final leaf and does not parse URL suffixes", () => {
  expect(fileViewKindForPath("dir.html/a.txt")).toBe("text");
  expect(fileViewKindForPath("a.html.exe")).toBeUndefined();
  expect(fileViewKindForPath("a.html?x=1")).toBeUndefined();
});

it.each([
  { path: "dir/.html", style: "POSIX" },
  { path: "C:\\dir\\.html", style: "Windows" },
  { path: "dir\\.html", style: "backslash-relative" },
  { path: "dir\\sub/.html", style: "mixed separators" },
  { path: "C:\\dir/.html", style: "mixed separators" },
])("rejects a dotfile-only final leaf ($path) under $style paths", ({ path }) => {
  expect(fileViewKindForPath(path)).toBeUndefined();
});

it("has a MIME type for every shared image extension", () => {
  const expected = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon" };
  for (const [ext, mime] of Object.entries(expected)) expect(imageMimeTypeForPath(`a.${ext}`)).toBe(mime);
});

it("exports the exact 64 MB preview cap and label", () => {
  expect(MAX_FILE_VIEW_BYTES).toBe(67_108_864);
  expect(MAX_FILE_VIEW_LABEL).toBe("64 MB");
});
