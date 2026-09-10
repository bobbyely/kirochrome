import type { KcError } from "@kirochrome/shared";

/**
 * Every RPC gets a timeout (invariant 10). A hung request must become a typed
 * error, because a permanent spinner is a bug and not a state.
 *
 * The caller supplies the error rather than a message, so the code and the
 * remediation belong to the call that hung.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => KcError,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
