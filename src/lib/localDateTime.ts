// A date-time box (<input type="datetime-local">) holds LOCAL time with no zone. Filling it from toISOString() (UTC)
// and reading it back as local shifted every EAS Logbook entry by the UTC offset on each save (dead-controls item 20 —
// an FCC record). This fills it in local time, the way the box reads it back.
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
