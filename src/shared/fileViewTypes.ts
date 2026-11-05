export type FileViewKind = "document" | "pdf" | "image" | "text";

export const MAX_FILE_VIEW_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_VIEW_LABEL = "64 MB";

const FILE_VIEW_KINDS: readonly FileViewKind[] = ["document", "pdf", "image", "text"];

const EXTENSIONS: Readonly<Record<FileViewKind, readonly string[]>> = {
  document: [".html", ".htm", ".svg"],
  pdf: [".pdf"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"],
  text: [".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log", ".xml", ".yaml", ".yml", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".py", ".sh", ".rs", ".go", ".java", ".c", ".h", ".cc", ".cpp", ".hpp", ".toml", ".ini", ".conf"],
};

export function fileViewKindForPath(path: string): FileViewKind | undefined {
  const leaf = path.split(/[\\/]/u).at(-1) ?? "";
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0 || dot === leaf.length - 1) return undefined;
  const ext = leaf.slice(dot).toLowerCase();
  return FILE_VIEW_KINDS.find((kind) => EXTENSIONS[kind].includes(ext));
}
