import { textMessage } from "./chatMessages";
import type { ChatLine } from "./components/shared";
import type { SessionUiEvent } from "./sessionSocket";

export function shellStartMessage(command: string, excludeFromContext?: boolean): ChatLine {
  return textMessage("bash", `${excludeFromContext === true ? "excluded from context\n\n" : ""}$ ${command}`);
}

export function appendShellChunk(messages: ChatLine[], chunk: string): ChatLine[] {
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role !== "bash" || lastPart?.type !== "text") return [...messages, textMessage("bash", chunk)];
  const separator = hasShellOutput(lastPart.text) ? "" : "\n\n";
  return [...messages.slice(0, -1), { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: lastPart.text + separator + chunk }] }];
}

export function finalizeShellMessage(messages: ChatLine[], event: Extract<SessionUiEvent, { type: "shell.end" }>): ChatLine[] {
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role !== "bash" || lastPart?.type !== "text") return messages;

  const shellText = event.output === undefined
    ? lastPart.text
    : replaceShellOutput(lastPart.text, event.output);
  const notes: string[] = [];
  if (!lastPart.text.includes("\n\n") && (event.output === undefined || event.output === "")) notes.push("(no output)");
  if (event.isError === true && (event.output === undefined || event.output === "")) notes.push("Bash command failed");
  if (event.exitCode != null) notes.push(`exit ${String(event.exitCode)}`);
  if (event.cancelled === true) notes.push("cancelled");
  if (event.truncated === true) notes.push("output truncated");
  if (event.fullOutputPath !== undefined && event.fullOutputPath !== "") notes.push(`full output: ${event.fullOutputPath}`);

  const finalizedText = notes.length === 0 ? shellText : `${shellText}\n\n${notes.join("\n")}`;
  if (finalizedText === lastPart.text) return messages;
  return [...messages.slice(0, -1), { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: finalizedText }] }];
}

function replaceShellOutput(text: string, output: string): string {
  const promptStart = text.indexOf("$ ");
  const outputStart = promptStart < 0 ? -1 : text.indexOf("\n\n", promptStart);
  const commandPrefix = outputStart < 0 ? text : text.slice(0, outputStart);
  return output === "" ? commandPrefix : `${commandPrefix}\n\n${output}`;
}

function hasShellOutput(text: string): boolean {
  const outputStart = text.lastIndexOf("\n\n");
  const promptStart = text.lastIndexOf("$ ");
  return outputStart > promptStart;
}
