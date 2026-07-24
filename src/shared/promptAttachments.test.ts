import { describe, expect, it } from "vitest";
import { base64ByteLength, extensionForImageMimeType, isSupportedImageMimeType, MAX_INLINE_IMAGE_BASE64_BYTES, parsePromptAttachments } from "./promptAttachments.js";

const validImageBase64 = "QUJD";

describe("isSupportedImageMimeType", () => {
  it("accepts pi-supported image types", () => {
    expect(isSupportedImageMimeType("image/png")).toBe(true);
    expect(isSupportedImageMimeType("image/jpeg")).toBe(true);
    expect(isSupportedImageMimeType("image/gif")).toBe(true);
    expect(isSupportedImageMimeType("image/webp")).toBe(true);
  });

  it("rejects unsupported types", () => {
    expect(isSupportedImageMimeType("image/svg+xml")).toBe(false);
    expect(isSupportedImageMimeType("application/pdf")).toBe(false);
    expect(isSupportedImageMimeType(42)).toBe(false);
  });
});

describe("extensionForImageMimeType", () => {
  it("maps mime types to file extensions", () => {
    expect(extensionForImageMimeType("image/jpeg")).toBe("jpg");
    expect(extensionForImageMimeType("image/png")).toBe("png");
    expect(extensionForImageMimeType("image/gif")).toBe("gif");
    expect(extensionForImageMimeType("image/webp")).toBe("webp");
    expect(extensionForImageMimeType("image/unknown")).toBe("bin");
  });
});

describe("base64ByteLength", () => {
  it("computes decoded byte length", () => {
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength("QQ==")).toBe(1);
    expect(base64ByteLength("QUI=")).toBe(2);
    expect(base64ByteLength("QUJD")).toBe(3);
  });
});

describe("parsePromptAttachments", () => {
  it("returns an empty array for undefined", () => {
    expect(parsePromptAttachments(undefined)).toEqual([]);
  });

  it("normalizes valid attachments", () => {
    const result = parsePromptAttachments([{ kind: "image", mimeType: "image/png", data: validImageBase64, name: "shot.png" }]);
    expect(result).toEqual([{ kind: "image", mimeType: "image/png", data: validImageBase64, name: "shot.png" }]);
  });

  it("drops empty names", () => {
    const result = parsePromptAttachments([{ kind: "image", mimeType: "image/png", data: validImageBase64, name: "" }]);
    expect(result[0]).not.toHaveProperty("name");
  });

  it("rejects non-array input", () => {
    expect(() => parsePromptAttachments({})).toThrow(/must be an array/);
  });

  it("rejects unsupported kinds and mime types", () => {
    expect(() => parsePromptAttachments([{ kind: "video", mimeType: "image/png", data: validImageBase64 }])).toThrow(/unsupported kind/);
    expect(() => parsePromptAttachments([{ kind: "file", mimeType: "application/pdf", data: validImageBase64 }])).toThrow(/unsupported kind/);
    expect(() => parsePromptAttachments([{ kind: "image", mimeType: "image/svg+xml", data: validImageBase64 }])).toThrow(/unsupported image type/);
  });

  it("accepts generic files only when file attachments are allowed", () => {
    const result = parsePromptAttachments(
      [{ kind: "file", mimeType: "application/pdf", data: "QUJD", name: "report.pdf" }],
      { allowFileAttachments: true },
    );
    expect(result).toEqual([{ kind: "file", mimeType: "application/pdf", data: "QUJD", name: "report.pdf" }]);
  });

  it("accepts zero-byte generic files", () => {
    const result = parsePromptAttachments(
      [{ kind: "file", mimeType: "text/plain", data: "", name: "empty.txt" }],
      { allowFileAttachments: true },
    );
    expect(result).toEqual([{ kind: "file", mimeType: "text/plain", data: "", name: "empty.txt" }]);
  });

  it("rejects generic files with empty mime types", () => {
    expect(() => parsePromptAttachments([{ kind: "file", mimeType: "", data: "QUJD" }], { allowFileAttachments: true })).toThrow(/invalid file type/);
  });

  it("keeps image MIME validation when file attachments are allowed", () => {
    expect(() => parsePromptAttachments([{ kind: "image", mimeType: "image/svg+xml", data: validImageBase64 }], { allowFileAttachments: true })).toThrow(/unsupported image type/);
  });

  it("rejects invalid base64 data", () => {
    expect(() => parsePromptAttachments([{ kind: "image", mimeType: "image/png", data: "not base64!!!" }])).toThrow(/invalid base64/);
  });

  it("enforces the inline size limit when requested", () => {
    const oversized = "A".repeat(MAX_INLINE_IMAGE_BASE64_BYTES * 2);
    expect(() => parsePromptAttachments([{ kind: "image", mimeType: "image/png", data: oversized }], { enforceInlineSizeLimit: true })).toThrow(/inline image size limit/);
    expect(parsePromptAttachments([{ kind: "image", mimeType: "image/png", data: oversized }])).toHaveLength(1);
  });

  it("enforces the attachment count limit", () => {
    const many = Array.from({ length: 3 }, () => ({ kind: "image", mimeType: "image/png", data: validImageBase64 }));
    expect(() => parsePromptAttachments(many, { maxAttachments: 2 })).toThrow(/too many attachments/);
  });
});
