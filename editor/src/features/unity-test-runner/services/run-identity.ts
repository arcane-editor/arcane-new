/** Legacy events may join only legacy runs; null is never a wildcard. */
export function sameTestRun(activeId: string | undefined, eventId: unknown): boolean {
  const id = typeof eventId === 'string' && eventId.length ? eventId : undefined;
  return activeId === id;
}
