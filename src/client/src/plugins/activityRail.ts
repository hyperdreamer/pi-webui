import type { TemplateResult } from "lit";
import type { ActivityRailContext, QualifiedActivityRailContribution, QualifiedContributionId } from "./types";

export interface ActivityRailDisplayItem {
  id: QualifiedContributionId;
  title: string;
  icon: TemplateResult;
  badge?: string | number | TemplateResult | undefined;
}

export type ActivityRailErrorPhase = "visible" | "badge" | "render";

export type ReportActivityRailError = (
  phase: ActivityRailErrorPhase,
  contributionId: QualifiedContributionId,
  error: unknown,
) => void;

export function isActivityRailItemVisible(
  contribution: QualifiedActivityRailContribution,
  context: ActivityRailContext,
  reportError: ReportActivityRailError,
): boolean {
  try {
    return contribution.visible?.(context) !== false;
  } catch (error) {
    reportError("visible", contribution.id, error);
    return false;
  }
}

export function visibleActivityRailItems(
  contributions: readonly QualifiedActivityRailContribution[],
  context: ActivityRailContext,
  reportError: ReportActivityRailError,
): ActivityRailDisplayItem[] {
  const items: ActivityRailDisplayItem[] = [];

  for (const contribution of contributions) {
    if (!isActivityRailItemVisible(contribution, context, reportError)) continue;

    let badge: ActivityRailDisplayItem["badge"];
    try {
      badge = contribution.badge?.(context);
    } catch (error) {
      reportError("badge", contribution.id, error);
    }

    items.push({
      id: contribution.id,
      title: contribution.title,
      icon: contribution.icon,
      badge,
    });
  }

  return items;
}

export function renderActivityRailBody(
  contribution: QualifiedActivityRailContribution,
  context: ActivityRailContext,
  reportError: ReportActivityRailError,
): TemplateResult | undefined {
  try {
    return contribution.render(context);
  } catch (error) {
    reportError("render", contribution.id, error);
    return undefined;
  }
}
