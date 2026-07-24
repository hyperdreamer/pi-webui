import { html, type TemplateResult } from "lit";
import type { WorkspaceLabelItem } from "../plugins/types";

export function renderWorkspaceLabelInlineItems(items: WorkspaceLabelItem[] = []): TemplateResult[] {
  return items.map((item, index) => html`${index === 0 ? null : html`<span class="workspace-label-separator">·</span>`}${renderWorkspaceLabelItem(item)}`);
}

function renderWorkspaceLabelItem(item: WorkspaceLabelItem): TemplateResult {
  if (item.type === "render") return html`<span class="workspace-label-render">${item.render()}</span>`;
  if (item.type === "link" && isSafeHref(item.href)) {
    const target = item.target ?? "_blank";
    const rel = target === "_blank" ? "noopener noreferrer" : undefined;
    return html`<a class="workspace-label-item workspace-label-link" href=${item.href} title=${item.title ?? item.text} target=${target} rel=${rel ?? undefined}>${item.text}</a>`;
  }
  return html`<span class="workspace-label-item" title=${item.title ?? item.text}>${item.text}</span>`;
}

function isSafeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase();
  return trimmed !== "" && !trimmed.startsWith("javascript:") && !trimmed.startsWith("data:");
}
