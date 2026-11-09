// The profile page's activity grids (profile.tsx), apart from React so
// node --test can run them (profile-grid.test.ts).
export type Day = { date: string; count: number };

/** Weeks as columns, Sunday at the top, as GitHub draws it. */
export function weeks(days: Day[]): (Day | null)[][] {
  if (!days.length) return [];
  const first = new Date(`${days[0]!.date}T12:00:00`).getDay();
  const cells: (Day | null)[] = [...new Array<null>(first).fill(null), ...days];
  const out: (Day | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  return out;
}

/** 0 to 4, against the busiest day, so a quiet year still shows its shape. */
export function level(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}
