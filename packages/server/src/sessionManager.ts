import { randomUUID } from "node:crypto";
import {
  isProviderFault,
  kcError,
  type KcError,
  type KcEvent,
  type ProviderConfig,
  type SessionSummary,
} from "@kirochrome/shared";
import { Session } from "./session.js";
import type { Store } from "./store.js";

/**
 * Owns live sessions and reads dead ones back from the log.
 *
 * A session that is not in memory is not gone — its transcript is on disk and
 * can be read. Re-attaching an agent to it (`session/load`) is phase 4; until
 * then a restored session is read-only.
 */
export class SessionManager {
  private readonly live = new Map<string, Session>();
  private readonly changeListeners = new Set<() => void>();
  /**
   * Resumes already under way, keyed by session id.
   *
   * `resume` awaits a handshake, so without this a second call arriving in that
   * window sees an empty `live` map and starts a second Session for the same
   * conversation. Both then append from the same seq — a UNIQUE violation on
   * (session_id, seq) — and both spawn their own agent. Two tabs, a
   * double-clicked Resume button, or a reconnect are all enough.
   */
  private readonly resuming = new Map<string, Promise<Session>>();

  constructor(private readonly store: Store) {}

  /**
   * Notified whenever any live session changes state, so connected clients can
   * keep the conversation list current without polling.
   */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private track(session: Session): void {
    this.live.set(session.id, session);
    const broadcast = () => {
      for (const fn of this.changeListeners) fn();
    };
    session.onStateChange(broadcast);
    // A dead agent is not a live session: drop it so prompting reports
    // SESSION_NOT_LIVE with a way forward, rather than a confusing
    // "the agent is not connected" from a session the UI still thinks is fine.
    session.onExit((reason) => {
      this.live.delete(session.id);
      // Invariant 11: a runtime failure contradicts the provider's last check,
      // so stop trusting it until it is re-checked. But only a failure that is
      // about the *provider* — one conversation crashing is not evidence the
      // binary or the login is wrong, and condemning the provider would remove
      // it from the new-chat list while another session runs on it happily.
      if (reason.providerAtFault) this.store.markStale(session.provider.id);
      broadcast();
    });
    broadcast();
  }

  async open(provider: ProviderConfig, cwd?: string): Promise<Session> {
    const session = await this.staleOnFailure(provider, () =>
      Session.open(randomUUID(), provider, this.store, cwd),
    );
    this.track(session);
    return session;
  }

  /**
   * Failures that say the provider itself is wrong — a missing binary, a failed
   * handshake, an expired login — mark it stale so it drops out of the new-chat
   * list until re-checked. Session-level failures do not.
   */
  private async staleOnFailure<T>(provider: ProviderConfig, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isProviderFault((err as KcError | undefined)?.code)) this.store.markStale(provider.id);
      throw err;
    }
  }

  /** Re-attaches an agent to a stored conversation so it can be continued. */
  async resume(id: string, provider: ProviderConfig): Promise<Session> {
    const existing = this.live.get(id);
    if (existing) return existing;

    const inFlight = this.resuming.get(id);
    if (inFlight) return inFlight;

    const record = this.store.getSession(id);
    if (!record) throw kcError("SESSION_UNKNOWN", `No session '${id}'.`);

    const attempt = this.staleOnFailure(provider, () => Session.resume(record, provider, this.store))
      .then((session) => {
        this.track(session);
        return session;
      })
      .finally(() => this.resuming.delete(id));

    this.resuming.set(id, attempt);
    return attempt;
  }

  getLive(id: string): Session | null {
    return this.live.get(id) ?? null;
  }

  /** Live log if the session is running, otherwise replayed from disk. */
  eventsSince(id: string, sinceSeq: number): KcEvent[] {
    const session = this.live.get(id);
    if (session) return session.eventsSince(sinceSeq);
    if (!this.store.getSession(id)) throw kcError("SESSION_UNKNOWN", `No session '${id}'.`);
    return this.store.eventsSince(id, sinceSeq);
  }

  summary(id: string): SessionSummary {
    const session = this.live.get(id);
    if (session) return session.summary();

    const record = this.store.getSession(id);
    if (!record) throw kcError("SESSION_UNKNOWN", `No session '${id}'.`);
    return {
      id: record.id,
      providerId: record.providerId,
      providerName: record.providerName,
      cwd: record.cwd,
      busy: false,
      lastSeq: this.store.lastSeq(id),
      title: record.title,
      live: false,
      configOptions: [],
      autoApprove: false,
      awaitingInput: false,
      queued: [],
      archived: record.status === "archived",
      supportsImages: false,
      commands: [],
    };
  }

  list(limit = 100, includeArchived = false): SessionSummary[] {
    return this.store.listSessions(limit, includeArchived).map((record) => {
      const session = this.live.get(record.id);
      const summary = session ? session.summary() : this.summary(record.id);
      return { ...summary, title: record.title, archived: record.status === "archived" };
    });
  }

  /**
   * Archives or restores a conversation.
   *
   * Archiving detaches the agent: putting a conversation away should not leave
   * a subprocess running for it. The log is untouched, so 'Resume conversation'
   * brings it back.
   */
  setArchived(id: string, archived: boolean): void {
    if (!this.store.getSession(id)) throw kcError("SESSION_UNKNOWN", `No session '${id}'.`);
    if (archived) {
      const live = this.live.get(id);
      if (live) {
        this.live.delete(id);
        live.close();
      }
    }
    this.store.setArchived(id, archived);
    for (const fn of this.changeListeners) fn();
  }

  /** Requires a live session — prompting a restored one is not possible yet. */
  requireLive(id: string): Session {
    const session = this.live.get(id);
    if (session) return session;
    if (this.store.getSession(id)) {
      throw kcError("SESSION_NOT_LIVE", "This conversation has no agent attached.", {
        remediation:
          "Use 'Resume conversation' to attach an agent and carry on. The transcript is safe either way.",
      });
    }
    throw kcError("SESSION_UNKNOWN", `No session '${id}'.`);
  }

  search(query: string) {
    return this.store.searchSessions(query);
  }

  /** Renames a conversation, whether or not it currently has an agent attached. */
  rename(id: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) throw kcError("INTERNAL", "A chat name cannot be empty.");

    const live = this.live.get(id);
    if (live) {
      live.rename(trimmed);
      return;
    }
    if (!this.store.getSession(id)) throw kcError("SESSION_UNKNOWN", `No session '${id}'.`);
    this.store.renameSession(id, trimmed);
  }

  /** Distinct directories already worked in, most recent first. */
  recentWorkspaces(limit = 10): string[] {
    const seen: string[] = [];
    for (const record of this.store.listSessions(200)) {
      if (!seen.includes(record.cwd)) seen.push(record.cwd);
      if (seen.length >= limit) break;
    }
    return seen;
  }

  closeAll(): void {
    for (const session of this.live.values()) session.close();
    this.live.clear();
  }
}
