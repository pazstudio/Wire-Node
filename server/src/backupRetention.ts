/**
 * Which automatic backups to keep: the newest `keep`, plus the newest backup of each day for the
 * last `keepDays` days that have a backup (days without one, e.g. while the server was off, do not
 * count, so there are always that many daily backups once enough days have passed).
 */
export function backupsToKeep(
  files: { name: string; day: string }[],
  settings: { keep: number; keepDays: number },
): Set<string> {
  const newestFirst = [...files].sort((a, b) => b.name.localeCompare(a.name));
  const keep = new Set(newestFirst.slice(0, settings.keep).map((f) => f.name));
  const days = new Set<string>();
  for (const f of newestFirst) {
    if (days.size >= settings.keepDays) break;
    if (days.has(f.day)) continue;
    days.add(f.day);
    keep.add(f.name);
  }
  return keep;
}

/** "wire-node-auto-20261116-102026.tar.gz" -> "2026-11-16" (UTC, as in the file name). */
export function backupDay(name: string) {
  const m = /-(\d{4})(\d{2})(\d{2})-\d{6}\.tar\.gz$/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
