/** Real interop dependency used by the corpus example and its output checks. */
export function formatShortDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
