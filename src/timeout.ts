// Bound a whole async operation by wall-clock time. notion-to-md's recursive
// block fetch makes hundreds of sequential calls, so a per-request timeout does
// not bound it — only a deadline around the entire promise does.
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline exceeded after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
