// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Workspace } from "../../shared/apiTypes";
import { toSafeMarkdownHtml } from "./formatting/markdown";
import { resolveTranscriptFilePreviewUrl, transcriptFileLinkContext, type TranscriptFileLinkContext } from "./transcriptFileLinks";

const appOrigin = "https://gateway.example";
const encodedFileViewPath = "/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view";

let base: HTMLBaseElement;

beforeEach(() => {
  vi.stubEnv("BASE_URL", "./");
  base = document.createElement("base");
  base.href = `${appOrigin}/`;
  document.head.append(base);
});

afterEach(() => {
  base.remove();
  document.body.replaceChildren();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const context: TranscriptFileLinkContext = {
  cwd: "/ramdisk",
  projectId: "project /?",
  workspaceId: "workspace ?/",
  machineId: "remote /?",
  appBasePath: "/",
};

function resolved(raw: string, overrides: Partial<TranscriptFileLinkContext> = {}): URL {
  const result = resolveTranscriptFilePreviewUrl(raw, { ...context, ...overrides });
  expect(result).toBeDefined();
  return new URL(result ?? "");
}

function workspace(id: string, path: string, projectId = "project /?"): Workspace {
  return { id, path, projectId, label: id, isMain: false, isGitRepo: false, isGitWorktree: false };
}

const candidates = [
  ["root cwd child HTML", "/ramdisk/pelican-bicycle.html", "pelican-bicycle.html", ""],
  ["cwd child unknown extension", "/ramdisk/output.unknown", "output.unknown", ""],
  ["cwd exact root", "/ramdisk", ".", ""],
  ["relative HTML", "a.html", "a.html", ""],
  ["./-relative PDF", "././reports/a.pdf", "reports/a.pdf", ""],
  ["root external PNG preserved absolute", "/outside/a.png", "/outside/a.png", ""],
  ["empty-authority file URL", "file:///ramdisk/a.html", "a.html", ""],
  ["localhost file URL", "file://localhost/ramdisk/a.html#part", "a.html", "#part"],
  ["uppercase file scheme", "FILE:///ramdisk/a.pdf?download=1#page=3", "a.pdf", "#page=3"],
  ["encoded Unicode/space filename", "caf%C3%A9%20plot.html", "café plot.html", ""],
  ["encoded literal ?/#", "a%3F%23.html?discard=yes#part", "a?#.html", "#part"],
  ["literal plus", "a+b.html", "a+b.html", ""],
  ["malformed percent fallback", "a%ZZ.html", "a%ZZ.html", ""],
  ["invalid UTF-8 fallback", "a%FF.html", "a%FF.html", ""],
  ["once-only %2520 decode", "a%2520.html", "a%20.html", ""],
  ["dropped query", "a.html?discard=yes", "a.html", ""],
  ["PDF page fragment", "a.pdf#page=3", "a.pdf", "#page=3"],
  ["query plus fragment", "a.pdf?download=1#page=3", "a.pdf", "#page=3"],
  ["query inside fragment", "a.html#part?still-fragment", "a.html", "#part?still-fragment"],
] as const;

for (const [name, raw, path, hash] of candidates) {
  it(`resolves ${name}`, () => {
    const url = resolved(raw);
    expect(url.origin).toBe("https://gateway.example");
    expect(url.pathname).toBe(encodedFileViewPath);
    expect(url.searchParams.get("path")).toBe(path);
    expect(url.hash).toBe(hash);
  });
}

it.each([
  "",
  "   ",
  "#part",
  "?view=a.html",
  "http://outside.example/a.html",
  "https://outside.example/a.html",
  "mailto:user@example.test",
  "javascript:alert(1)",
  "//cdn.example/a.svg",
  "a.exe",
  "README",
  "/outside/README",
  "file://otherhost/ramdisk/a.html",
  "file://u:p@localhost/ramdisk/a.html",
  "file://localhost:123/ramdisk/a.html",
  "file:relative.html",
  "file:/ramdisk/a.html",
  String.raw`\\server\share\a.pdf`,
])("declines %s", (raw) => {
  expect(resolveTranscriptFilePreviewUrl(raw, context)).toBeUndefined();
});

for (const namespace of ["api", "pi-webui-plugins", "assets"]) {
  for (const prefix of ["", "./", "/", "encoded"]) {
    it(`excludes ${prefix} ${namespace}`, () => {
      const raw = prefix === "encoded"
        ? `%${namespace.charCodeAt(0).toString(16)}${namespace.slice(1)}/a.html`
        : `${prefix}${namespace}/a.html`;
      expect(resolveTranscriptFilePreviewUrl(raw, context)).toBeUndefined();
    });
  }
}

it("does not strip a near cwd prefix", () => {
  expect(resolved("/ramdisk2/a.html").searchParams.get("path")).toBe("/ramdisk2/a.html");
});

it("excludes a nested effective base without excluding its near-prefix or root deployment", () => {
  expect(resolveTranscriptFilePreviewUrl("/tools/pi/a.html", { ...context, appBasePath: "/tools/pi/" })).toBeUndefined();
  expect(resolved("/tools/piano/a.html", { appBasePath: "/tools/pi/" }).searchParams.get("path")).toBe("/tools/piano/a.html");
  expect(resolved("/ramdisk/a.html", context).searchParams.get("path")).toBe("a.html");
  expect(resolved("apian/a.html", context).searchParams.get("path")).toBe("apian/a.html");
});

it("retains traversal for the server authorization boundary", () => {
  expect(resolved("../a.html").searchParams.get("path")).toBe("../a.html");
});

it("resolves Marked-encoded Windows drive attributes", () => {
  const forms = [
    [String.raw`[local](<C:\Work\Repo\a.html>)`, "C:%5CWork%5CRepo%5Ca.html"],
    [String.raw`[local](<file:///C:\Work\Repo\a.html>)`, "file:///C:%5CWork%5CRepo%5Ca.html"],
    [String.raw`[local](<file://localhost/C:\Work\Repo\a.html>)`, "file://localhost/C:%5CWork%5CRepo%5Ca.html"],
  ] as const;
  for (const [markdown, expectedHref] of forms) {
    const template = document.createElement("template");
    template.innerHTML = toSafeMarkdownHtml(markdown);
    const href = template.content.querySelector("a")?.getAttribute("href");
    expect(href).toBe(expectedHref);
    expect(resolved(href ?? "", { cwd: "C:/Work/Repo" }).searchParams.get("path")).toBe("a.html");
  }
});

it("recognizes Windows paths before schemes and compares drive paths case-insensitively", () => {
  for (const cwd of ["C:\\Work\\Repo\\", "C:/Work/Repo", "c:/work/repo"]) {
    for (const raw of [
      "C:\\Work\\Repo\\a.html",
      "C:/Work/Repo/a.html",
      "c:/work/repo/a.html",
      "file:///C:/Work/Repo/a.html",
    ]) {
      expect(resolved(raw, { cwd }).searchParams.get("path"), `${cwd} ${raw}`).toBe("a.html");
    }
  }
  expect(resolved("C:/Work/Repo2/a.html", { cwd: "C:/Work/Repo" }).searchParams.get("path")).toBe("C:/Work/Repo2/a.html");
  expect(resolved("/Ramdisk/a.html", { cwd: "/ramdisk" }).searchParams.get("path")).toBe("/Ramdisk/a.html");
});

it("preserves filesystem roots during cwd comparison", () => {
  expect(resolved("/a.html", { cwd: "/" }).searchParams.get("path")).toBe("a.html");
  expect(resolved("/", { cwd: "/" }).searchParams.get("path")).toBe(".");
  expect(resolved("C:/a.html", { cwd: "C:/" }).searchParams.get("path")).toBe("a.html");
  expect(resolved("C:/", { cwd: "C:/" }).searchParams.get("path")).toBe(".");
});

it("returns context for the matching workspace rather than the selected-looking first workspace", () => {
  const workspaces = [workspace("first", "/first", "first-project"), workspace("workspace ?/", "/second", "project /?")];
  expect(transcriptFileLinkContext("/second", workspaces, "remote /?", "/")).toEqual({
    cwd: "/second",
    projectId: "project /?",
    workspaceId: "workspace ?/",
    machineId: "remote /?",
    appBasePath: "/",
  });
});

it("normalizes context comparisons only for slash and Windows case rules", () => {
  const match = (path: string, cwd: string) => transcriptFileLinkContext(cwd, [workspace("workspace ?/", path)], "remote /?", "/");
  expect(match("/ramdisk/", "/ramdisk")?.workspaceId).toBe("workspace ?/");
  expect(match("C:\\Work\\Repo", "C:/Work/Repo")?.workspaceId).toBe("workspace ?/");
  expect(match("c:/work/repo", "C:/Work/Repo")?.workspaceId).toBe("workspace ?/");
  expect(match("C:\\Work\\Repo\\", "c:/work/repo")?.workspaceId).toBe("workspace ?/");
  expect(match("/ramdisk", "/ramdisk ")).toBeUndefined();
  expect(match("/ram disk", "/ramdisk")).toBeUndefined();
  expect(match("/Ramdisk", "/ramdisk")).toBeUndefined();
  expect(match("/ramdisk/../ramdisk", "/ramdisk")).toBeUndefined();
});

it("disables context and direct resolution for incomplete ownership", () => {
  const workspaces = [workspace("workspace ?/", "/ramdisk")];
  expect(transcriptFileLinkContext(undefined, workspaces, "remote /?", "/")).toBeUndefined();
  expect(transcriptFileLinkContext("", workspaces, "remote /?", "/")).toBeUndefined();
  expect(transcriptFileLinkContext("/elsewhere", workspaces, "remote /?", "/")).toBeUndefined();
  expect(transcriptFileLinkContext("/ramdisk", [workspace("", "/ramdisk")], "remote /?", "/")).toBeUndefined();
  expect(transcriptFileLinkContext("/ramdisk", [{ ...workspace("w", "/ramdisk"), projectId: "" }], "remote /?", "/")).toBeUndefined();
  expect(transcriptFileLinkContext("/ramdisk", workspaces, "", "/")).toBeUndefined();
  expect(transcriptFileLinkContext("/ramdisk", workspaces, "remote /?", "tools/pi/")).toBeUndefined();
  expect(transcriptFileLinkContext("/ramdisk", workspaces, "remote /?", "//gateway.example/")).toBeUndefined();
  expect(transcriptFileLinkContext("/ramdisk", workspaces, "remote /?", "/tools/pi?x")).toBeUndefined();
  expect(transcriptFileLinkContext("/ramdisk", workspaces, "remote /?", "/tools\\pi")).toBeUndefined();

  for (const incomplete of [
    { cwd: "" },
    { projectId: "" },
    { workspaceId: "" },
    { machineId: "" },
    { appBasePath: "tools/pi/" },
    { appBasePath: "//gateway.example/" },
    { appBasePath: "/tools/pi#fragment" },
  ]) {
    expect(resolveTranscriptFilePreviewUrl("a.html", { ...context, ...incomplete })).toBeUndefined();
  }
});
