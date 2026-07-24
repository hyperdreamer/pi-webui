import type { PromptAttachmentDelivery } from "../../shared/apiTypes";
import { extensionForImageMimeType, isSupportedImageMimeType } from "../../shared/promptAttachments";

/**
 * Minimal view of a browser File needed to capture an attachment. Keeping this
 * structural (rather than depending on the DOM `File` type) lets the capture
 * logic be unit-tested without a browser environment.
 */
export interface CapturableFile {
  name: string;
  type: string;
  size: number;
}

export type CapturedAttachment =
  | {
    kind: "image";
    name: string;
    mimeType: string;
    /** Base64 payload without the data: URL prefix. */
    data: string;
    size: number;
  }
  | {
    kind: "file";
    name: string;
    mimeType: string;
    /** Base64 payload without the data: URL prefix. */
    data: string;
    size: number;
  };

export interface CaptureResult {
  attachments: CapturedAttachment[];
  error?: string;
}

export const DEFAULT_FILE_MIME_TYPE = "application/octet-stream";
export const READ_FAILURE_MESSAGE = "Failed to read an attachment.";

/**
 * Read a batch of browser files as prompt attachments.
 *
 * Pure orchestration: the actual byte reading is injected so the side effect
 * (FileReader/Blob access) stays at the component boundary and tests can supply
 * a fake reader. Supported image MIME types stay marked as native inline images;
 * every other file is captured as a generic file attachment that must be saved
 * into the workspace before being mentioned in the prompt.
 */
export async function capturePromptAttachments<T extends CapturableFile>(
  files: readonly T[],
  readBase64: (file: T) => Promise<string>,
): Promise<CaptureResult> {
  const attachments: CapturedAttachment[] = [];
  let error: string | undefined;
  for (const file of files) {
    try {
      const data = await readBase64(file);
      attachments.push(capturedAttachment(file, data));
    } catch {
      error = READ_FAILURE_MESSAGE;
    }
  }
  return { attachments, ...(error === undefined ? {} : { error }) };
}

export function isInlinePromptAttachment(attachment: Pick<CapturedAttachment, "kind" | "mimeType">): boolean {
  return attachment.kind === "image" && isSupportedImageMimeType(attachment.mimeType);
}

export function promptAttachmentsCanUseInlineDelivery(attachments: readonly Pick<CapturedAttachment, "kind" | "mimeType">[]): boolean {
  return attachments.every((attachment) => isInlinePromptAttachment(attachment));
}

export function effectivePromptAttachmentDelivery(
  preferredDelivery: PromptAttachmentDelivery,
  attachments: readonly Pick<CapturedAttachment, "kind" | "mimeType">[],
): PromptAttachmentDelivery {
  return promptAttachmentsCanUseInlineDelivery(attachments) ? preferredDelivery : "folder";
}

function capturedAttachment(file: CapturableFile, data: string): CapturedAttachment {
  if (isSupportedImageMimeType(file.type)) {
    return { kind: "image", name: attachmentName(file), mimeType: file.type, data, size: file.size };
  }
  return { kind: "file", name: attachmentName(file), mimeType: fileMimeType(file), data, size: file.size };
}

function fileMimeType(file: CapturableFile): string {
  const mimeType = file.type.trim();
  return mimeType === "" ? DEFAULT_FILE_MIME_TYPE : mimeType;
}

function attachmentName(file: CapturableFile): string {
  if (file.name !== "") return file.name;
  if (isSupportedImageMimeType(file.type)) return `pasted-image.${extensionForImageMimeType(file.type)}`;
  return "pasted-file.bin";
}
