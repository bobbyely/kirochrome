import { randomUUID } from "node:crypto";
import { kcError, type ProviderConfig } from "@kirochrome/shared";
import { Session } from "./session.js";

/** Owns live sessions. Persistence arrives in phase 3. */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  async open(provider: ProviderConfig): Promise<Session> {
    const session = await Session.open(randomUUID(), provider);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw kcError("INTERNAL", `No session '${id}'.`);
    return session;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
