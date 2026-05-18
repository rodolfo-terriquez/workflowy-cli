import { expect, test } from "bun:test";
import { buildSystemTargetMap } from "./system-targets.ts";

test("buildSystemTargetMap derives calendar and date targets from exported nodes", () => {
  const nodes = [
    { id: "calendar-root", name: "📆 Calendar", parent_id: null },
    { id: "year-2026", name: "2026", parent_id: "calendar-root" },
    { id: "month-may", name: "May", parent_id: "year-2026" },
    { id: "day-today", name: "<time startYear=\"2026\" startMonth=\"5\" startDay=\"18\">Mon, May 18, 2026</time>", parent_id: "month-may" },
    { id: "day-tomorrow", name: "<time startYear=\"2026\" startMonth=\"5\" startDay=\"19\">Tue, May 19, 2026</time>", parent_id: "month-may" },
  ];

  const mappings = buildSystemTargetMap(nodes, new Date("2026-05-18T12:00:00-06:00"));

  expect(mappings.calendar).toBe("calendar-root");
  expect(mappings.today).toBe("day-today");
  expect(mappings.tomorrow).toBe("day-tomorrow");
});

test("buildSystemTargetMap leaves missing targets unset instead of carrying stale values", () => {
  const nodes = [
    { id: "calendar-root", name: "📆 Calendar", parent_id: null },
    { id: "year-2026", name: "2026", parent_id: "calendar-root" },
    { id: "month-may", name: "May", parent_id: "year-2026" },
    { id: "day-old", name: "<time startYear=\"2026\" startMonth=\"5\" startDay=\"14\">Thu, May 14, 2026</time>", parent_id: "month-may" },
  ];

  const mappings = buildSystemTargetMap(nodes, new Date("2026-05-18T12:00:00-06:00"));

  expect(mappings.calendar).toBe("calendar-root");
  expect(mappings.today).toBeUndefined();
  expect(mappings.tomorrow).toBeUndefined();
});
