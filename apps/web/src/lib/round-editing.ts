/**
 * Which round tasks have a "not done" reason being typed (HZ-003). While any has, the round is not
 * read again behind the carer's back: a re-read could change the task's version under the form,
 * or take the task off the list and the typed reason with it. Reading again waits until the form
 * is sent or closed. Browser-only state, per page.
 */

const editing = new Set<string>();
const listeners = new Set<() => void>();

export function startEditing(taskId: string): void {
  editing.add(taskId);
}

export function stopEditing(taskId: string): void {
  if (!editing.delete(taskId)) return;
  if (editing.size === 0) for (const listener of [...listeners]) listener();
}

export function isEditing(): boolean {
  return editing.size > 0;
}

/** Called once nobody is typing any more; returns the way to stop listening. */
export function whenIdle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
