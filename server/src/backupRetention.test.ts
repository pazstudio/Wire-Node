import { describe, expect, it } from 'vitest';
import { backupDay, backupsToKeep } from './backupRetention.js';

/** Backups every `everyHours` for `days` days, ending 2026-11-30. */
function series(days: number, everyHours: number) {
  const files: { name: string; day: string }[] = [];
  const end = Date.UTC(2026, 10, 30, 23, 0, 0);
  for (let t = end - days * 86400_000 + everyHours * 3600_000; t <= end; t += everyHours * 3600_000) {
    const d = new Date(t).toISOString();
    const name = `wire-node-auto-${d.slice(0, 10).replace(/-/g, '')}-${d.slice(11, 19).replace(/:/g, '')}.tar.gz`;
    files.push({ name, day: backupDay(name) });
  }
  return files;
}

describe('backupsToKeep', () => {
  it('reads the day from the file name', () => {
    expect(backupDay('wire-node-auto-20261116-102026.tar.gz')).toBe('2026-11-16');
  });

  it('keeps the newest N plus one per day for the last 30 days', () => {
    const files = series(60, 6); // 4 backups a day for 60 days
    const keep = backupsToKeep(files, { keep: 14, keepDays: 30 });
    const days = new Set(files.filter((f) => keep.has(f.name)).map((f) => f.day));
    expect(days.size).toBe(30);
    // The newest 14 cover 3.5 days; 30 days get their newest backup (4 of them already among the 14).
    expect(keep.size).toBe(14 + 26);
    for (const f of [...files].sort((a, b) => b.name.localeCompare(a.name)).slice(0, 14)) expect(keep.has(f.name)).toBe(true);
    // Of each kept day only its newest backup (outside the newest 14).
    const oldest = files.filter((f) => f.day === '2026-11-01');
    expect(oldest.filter((f) => keep.has(f.name)).map((f) => f.name)).toEqual([oldest.at(-1)!.name]);
    expect(files.some((f) => f.day === '2026-10-31' && keep.has(f.name))).toBe(false);
  });

  it('daily backups are not lost to days without backups', () => {
    const files = series(60, 24).filter((_, i) => i % 2 === 0); // every other day
    const keep = backupsToKeep(files, { keep: 3, keepDays: 30 });
    expect(keep.size).toBe(30);
  });

  it('keepDays 0 keeps only the newest N', () => {
    expect(backupsToKeep(series(10, 6), { keep: 5, keepDays: 0 }).size).toBe(5);
  });
});
