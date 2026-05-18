import { cleanHtml } from "./nodes.ts";
import type { WFNode } from "./api.ts";

const SYSTEM_TARGET_KEYS = ["calendar", "today", "tomorrow", "next_week", "inbox"] as const;

export function buildSystemTargetMap(
  nodes: Array<Pick<WFNode, "id" | "name" | "parent_id">>,
  now = new Date(),
): Partial<Record<(typeof SYSTEM_TARGET_KEYS)[number], string>> {
  const byParent = new Map<string | null, Array<Pick<WFNode, "id" | "name" | "parent_id">>>();

  for (const node of nodes) {
    const parentId = node.parent_id ?? null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(node);
    byParent.set(parentId, siblings);
  }

  const findChildByName = (parentId: string | null, expectedName: string) =>
    (byParent.get(parentId) ?? []).find((node) => cleanHtml(node.name) === expectedName);

  const calendar = findChildByName(null, "📆 Calendar");
  const result: Partial<Record<(typeof SYSTEM_TARGET_KEYS)[number], string>> = {};

  if (!calendar) return result;
  result.calendar = calendar.id;

  const todayNode = findCalendarDateNode(byParent, calendar.id, now);
  if (todayNode) result.today = todayNode.id;

  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowNode = findCalendarDateNode(byParent, calendar.id, tomorrow);
  if (tomorrowNode) result.tomorrow = tomorrowNode.id;

  return result;
}

function findCalendarDateNode(
  byParent: Map<string | null, Array<Pick<WFNode, "id" | "name" | "parent_id">>>,
  calendarId: string,
  date: Date,
): Pick<WFNode, "id" | "name" | "parent_id"> | undefined {
  const year = String(date.getFullYear());
  const month = new Intl.DateTimeFormat("en-US", { month: "long" }).format(date);
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);

  const yearNode = (byParent.get(calendarId) ?? []).find((node) => cleanHtml(node.name) === year);
  if (!yearNode) return undefined;

  const monthNode = (byParent.get(yearNode.id) ?? []).find((node) => cleanHtml(node.name) === month);
  if (!monthNode) return undefined;

  return (byParent.get(monthNode.id) ?? []).find((node) => cleanHtml(node.name) === day);
}
