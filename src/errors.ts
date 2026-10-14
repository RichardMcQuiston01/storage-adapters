/** Turns an unknown thrown value into a readable message. */
export function describeUnknownError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message === '' ? cause.name : cause.message;
  }
  if (typeof cause === 'string') {
    return cause;
  }
  try {
    const json: string | undefined = JSON.stringify(cause);
    return json ?? String(cause);
  } catch {
    return String(cause);
  }
}
