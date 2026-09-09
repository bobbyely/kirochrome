/**
 * A bounded tail of text.
 *
 * The agent's stdout is the JSON-RPC channel and carries nothing readable; when
 * it crashes, the reason goes to stderr. This keeps the last N bytes of that so
 * it can be attached to any error report. It is the single highest-value
 * debugging artefact in the system — do not remove it to "tidy up".
 */
export class RingBuffer {
  private text = "";

  constructor(private readonly limit = 64_000) {}

  append(chunk: string): void {
    this.text = (this.text + chunk).slice(-this.limit);
  }

  /** The retained tail, or undefined when nothing was captured. */
  tail(): string | undefined {
    const trimmed = this.text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
