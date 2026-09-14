import { randomUUID } from "node:crypto";
import {
  causeOf,
  kcError,
  latestUsage,
  ROOM_DEFAULT_PAUSE,
  ROOM_DEFAULT_RULES,
  ROOM_DEFAULT_TURNS,
  ROOM_MAX_PARTICIPANTS,
  ROOM_MAX_TURNS,
  ROOM_MIN_PARTICIPANTS,
  ROOM_PASS,
  ROOM_USER,
  type KcError,
  type ProviderConfig,
  type Room,
  type RoomInput,
  type RoomMessage,
  type RoomParticipant,
  type RoomView,
} from "@kirochrome/shared";
import type { Session } from "./session.js";
import type { SessionManager } from "./sessionManager.js";
import { cleanStart } from "./startOptions.js";
import type { Store } from "./store.js";

/** What a room is doing right now. Not persisted: a restart ends any round. */
interface Runtime {
  running: boolean;
  speaking: string | null;
  /** The speaker's session seq when its turn began, so its partial reply can be read. */
  speakingFrom: number;
  turnsThisRound: number;
  /** Index into participants of who speaks next. */
  next: number;
  /** A round was cut short by a hold and has turns left. */
  resumable: boolean;
  /** The current turn was cut in on; its reply is not to be recorded. */
  cancelled: boolean;
  passes: number;
}

/**
 * Agents talking in turns, with the user able to speak at any time.
 *
 * Each participant is an ordinary session. A round — set off by the user
 * saying something, or by Continue — prompts each participant in order with
 * everything said since its last turn, records the reply in the room's own
 * log, and moves on, until the round's turn budget is spent or every agent
 * passes. The user's keystrokes hold the room: the turn in flight finishes,
 * nobody else is prompted until they send or clear the box.
 *
 * ACP has no way for agents to address each other, and no way to inject into
 * a running turn, so this is exactly what it looks like: prompts built from a
 * transcript, and `session/cancel` to cut in.
 */
export class RoomManager {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly providers: () => ProviderConfig[],
  ) {}

  /**
   * A round lives in this process; a restart ends it. Rooms that say
   * otherwise are put back to idle, and their agents re-attach on the next
   * turn — see `ensureLive`.
   */
  start(): void {
    const settled = this.store.settleRooms();
    if (settled > 0) console.log(`Settled ${settled} room(s) the previous server left mid-round.`);
  }

  list(): RoomView[] {
    return this.store.listRooms().map((room) => this.view(room));
  }

  get(id: string): RoomView {
    return this.view(this.require(id));
  }

  async create(input: RoomInput): Promise<Room> {
    const fields = this.validate(input);
    const now = Date.now();
    const room: Room = {
      ...fields,
      id: randomUUID(),
      participants: fields.participants.map((p) => ({ ...p, id: randomUUID(), sessionId: null, lastSeq: 0 })),
      status: "idle",
      creditsUsed: 0,
      createdAt: now,
      updatedAt: now,
    };
    // Agents are spawned now rather than on first use, so a provider that
    // will not start is found while the user is still on the form.
    for (const participant of room.participants) {
      const session = await this.openFor(room, participant);
      participant.sessionId = session.id;
    }
    this.store.upsertRoom(room);
    return room;
  }

  /** Changes what the room is for and how to behave. Takes effect on the next prompt. */
  steer(id: string, patch: { topic?: unknown; rules?: unknown }): Room {
    const room = this.require(id);
    const topic = typeof patch.topic === "string" && patch.topic.trim() ? patch.topic.trim() : room.topic;
    const rules = typeof patch.rules === "string" ? patch.rules.trim() || ROOM_DEFAULT_RULES : room.rules;
    const next = { ...room, topic, rules, updatedAt: Date.now() };
    this.store.upsertRoom(next);
    return next;
  }

  /** Ends any round, detaches the agents, and removes the room. Their conversations stay. */
  delete(id: string): void {
    const room = this.require(id);
    this.stop(id);
    for (const participant of room.participants) {
      if (participant.sessionId) this.sessions.detach(participant.sessionId);
    }
    this.runtimes.delete(id);
    this.store.deleteRoom(id);
  }

  /**
   * The user speaks. With `cutIn`, the agent mid-turn is cancelled and what
   * it was saying is dropped; otherwise it finishes first. Either way the
   * next agent sees this message, and a round starts if none is running.
   */
  async say(id: string, text: string, cutIn = false): Promise<void> {
    const room = this.require(id);
    const trimmed = text.trim();
    if (!trimmed) throw kcError("ROOM_INVALID", "Nothing to say.");
    const runtime = this.runtime(id);

    this.append(room, ROOM_USER, "You", trimmed);
    if (cutIn && runtime.speaking) {
      runtime.cancelled = true;
      await this.sessionOf(room, runtime.speaking)?.cancel();
    }
    if (room.status !== "running") this.setStatus(room, "idle");
    // The user speaking starts a fresh round, whatever was left of the last.
    runtime.resumable = false;
    void this.round(id);
  }

  /** Re-attaches every participant's agent now, rather than on its next turn. */
  async reconnect(id: string): Promise<void> {
    const room = this.require(id);
    for (const participant of room.participants) await this.ensureLive(room, participant);
  }

  /** Starts, or resumes, a round without the user saying anything. */
  resume(id: string): void {
    const room = this.require(id);
    if (room.status !== "running") this.setStatus(room, "idle");
    void this.round(id);
  }

  /**
   * Held while the user types. The turn in flight completes; nobody else is
   * prompted. Releasing a hold resumes the round where it stopped.
   */
  hold(id: string, held: boolean): void {
    const room = this.require(id);
    const runtime = this.runtime(id);
    if (held) {
      if (room.status === "running" || room.status === "idle") this.setStatus(room, "held");
      return;
    }
    if (room.status !== "held") return;
    this.setStatus(room, "idle");
    if (runtime.resumable) void this.round(id);
  }

  stop(id: string): void {
    const room = this.require(id);
    const runtime = this.runtime(id);
    this.setStatus(room, "stopped");
    runtime.resumable = false;
    if (runtime.speaking) {
      runtime.cancelled = true;
      void this.sessionOf(room, runtime.speaking)?.cancel();
    }
  }

  // ---------- the round ----------

  private async round(id: string): Promise<void> {
    const runtime = this.runtime(id);
    if (runtime.running) return;
    runtime.running = true;
    if (!runtime.resumable) {
      runtime.turnsThisRound = 0;
      runtime.passes = 0;
    }
    runtime.resumable = false;
    this.setStatus(this.require(id), "running");

    try {
      for (;;) {
        const room = this.require(id);
        if (room.status !== "running") {
          runtime.resumable = room.status === "held";
          return;
        }
        if (runtime.turnsThisRound >= room.maxTurnsPerRound) return;
        if (runtime.passes >= room.participants.length) return; // everyone has nothing to add

        const participant = room.participants[runtime.next % room.participants.length];
        if (!participant) return;
        runtime.next = (runtime.next + 1) % room.participants.length;

        let said: string | null;
        try {
          said = await this.turn(room, participant);
        } catch (err) {
          // A participant that cannot answer stops the room rather than being
          // skipped forever in silence; the message says who and why.
          const error = isKcError(err) ? err : kcError("INTERNAL", String(err));
          const current = this.require(id);
          this.append(current, ROOM_USER, "Room", `${participant.name} could not answer: ${error.message}`);
          this.setStatus(current, "stopped");
          return;
        }
        runtime.turnsThisRound += 1;
        runtime.passes = said === null ? runtime.passes + 1 : 0;

        const after = this.require(id);
        if (after.creditCap !== null && after.creditsUsed >= after.creditCap) {
          this.setStatus(after, "stopped");
          this.append(after, ROOM_USER, "Room", `Credit cap of ${after.creditCap} reached; the room is stopped.`);
          return;
        }
        if (after.pauseSeconds > 0) await sleep(after.pauseSeconds * 1000);
      }
    } finally {
      runtime.running = false;
      runtime.speaking = null;
      const room = this.store.getRoom(id);
      if (room?.status === "running") this.setStatus(room, "idle");
    }
  }

  /** One agent's turn. Returns what it said, or null if it passed or was cut off. */
  private async turn(room: Room, participant: RoomParticipant): Promise<string | null> {
    const runtime = this.runtime(room.id);
    runtime.speaking = participant.id;
    runtime.cancelled = false;

    const session = await this.ensureLive(room, participant);
    const shown = this.store.lastRoomSeq(room.id);
    const prompt = this.promptFor(room, participant);
    const before = session.summary().lastSeq;
    runtime.speakingFrom = before;
    const creditsBefore = latestUsage(session.eventsSince(0))?.credits ?? 0;

    try {
      await session.prompt(prompt);
    } finally {
      runtime.speaking = null;
    }

    // What it said is the text it streamed this turn; tool chatter is in its
    // own transcript, not the room's.
    const reply = saidSince(session, before);
    const spent = (latestUsage(session.eventsSince(0))?.credits ?? 0) - creditsBefore;

    const fresh = this.require(room.id);
    const mine = fresh.participants.find((p) => p.id === participant.id);
    if (mine) mine.lastSeq = shown;
    fresh.creditsUsed += Math.max(0, spent);
    this.store.upsertRoom({ ...fresh, updatedAt: Date.now() });

    if (runtime.cancelled || !reply || reply.toUpperCase() === ROOM_PASS) return null;
    this.append(fresh, participant.id, participant.name, reply);
    return reply;
  }

  /**
   * The whole of what an agent knows about the room is this prompt: who it
   * is, who else is there, the topic, the rules, and what was said since it
   * last spoke. Its own session keeps the earlier prompts as context.
   */
  private promptFor(room: Room, me: RoomParticipant): string {
    const others = room.participants.filter((p) => p.id !== me.id).map((p) => `${p.name} (${p.role})`);
    const since = this.store.roomMessages(room.id, me.lastSeq);
    const transcript = since.length
      ? since.map((m) => `[${m.name}] ${m.text}`).join("\n\n")
      : "(nothing yet — open the discussion)";
    return [
      `You are ${me.name} — ${me.role}. You are in a room called "${room.name}" with ${others.join(", ")} and the user (the person running this).`,
      `Topic: ${room.topic}`,
      `Rules: ${room.rules || ROOM_DEFAULT_RULES}`,
      `Said since your last turn:\n\n${transcript}`,
      `Your reply:`,
    ].join("\n\n");
  }

  // ---------- sessions ----------

  private async ensureLive(room: Room, participant: RoomParticipant): Promise<Session> {
    const provider = this.provider(participant.providerId);
    if (participant.sessionId) {
      const live = this.sessions.getLive(participant.sessionId);
      if (live) return live;
      try {
        return await this.sessions.resume(participant.sessionId, provider);
      } catch (err) {
        // The agent cannot reload it: start fresh and show it the whole room.
        // Say so, with the cause — a silent fallback hides an agent that has
        // started refusing every load.
        console.warn(`[room ${room.id}] could not resume ${participant.name}; starting fresh:`, causeOf(err));
      }
    }
    const session = await this.openFor(room, participant);
    const fresh = this.require(room.id);
    const mine = fresh.participants.find((p) => p.id === participant.id);
    if (mine) {
      mine.sessionId = session.id;
      mine.lastSeq = 0;
      this.store.upsertRoom(fresh);
    }
    participant.lastSeq = 0;
    return session;
  }

  private async openFor(room: Room, participant: RoomParticipant): Promise<Session> {
    const session = await this.sessions.open(this.provider(participant.providerId), room.cwd, participant.start);
    session.tagRoom(room.id, `${room.name} · ${participant.name}`);
    return session;
  }

  private sessionOf(room: Room, participantId: string): Session | null {
    const participant = room.participants.find((p) => p.id === participantId);
    return participant?.sessionId ? this.sessions.getLive(participant.sessionId) : null;
  }

  private provider(id: string): ProviderConfig {
    const provider = this.providers().find((p) => p.id === id);
    if (!provider) throw kcError("PROVIDER_UNKNOWN", `No provider configured with id '${id}'.`);
    return provider;
  }

  // ---------- bookkeeping ----------

  private append(room: Room, speaker: string, name: string, text: string): RoomMessage {
    const message: RoomMessage = {
      id: randomUUID(),
      roomId: room.id,
      seq: this.store.lastRoomSeq(room.id) + 1,
      ts: Date.now(),
      speaker,
      name,
      text,
    };
    this.store.appendRoomMessage(message);
    return message;
  }

  private setStatus(room: Room, status: Room["status"]): void {
    this.store.upsertRoom({ ...room, status, updatedAt: Date.now() });
  }

  private view(room: Room): RoomView {
    const runtime = this.runtime(room.id);
    const speaker = runtime.speaking ? this.sessionOf(room, runtime.speaking) : null;
    return {
      ...room,
      messages: this.store.roomMessages(room.id),
      live: room.participants.filter((p) => p.sessionId && this.sessions.getLive(p.sessionId)).map((p) => p.id),
      speaking: runtime.speaking,
      speakingText: speaker ? saidSince(speaker, runtime.speakingFrom) : "",
      turnsThisRound: runtime.turnsThisRound,
    };
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = {
        running: false,
        speaking: null,
        speakingFrom: 0,
        turnsThisRound: 0,
        next: 0,
        resumable: false,
        cancelled: false,
        passes: 0,
      };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private require(id: string): Room {
    const room = this.store.getRoom(id);
    if (!room) throw kcError("ROOM_UNKNOWN", `No room '${id}'.`);
    return room;
  }

  /** Field by field, like every other thing a browser form sends. */
  private validate(input: RoomInput): Omit<RoomInput, "participants"> & { participants: RoomInput["participants"] } {
    const problems: string[] = [];
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const name = str(input.name);
    const cwd = str(input.cwd);
    const topic = str(input.topic);
    const rules = str(input.rules) || ROOM_DEFAULT_RULES;
    const maxTurnsPerRound = Number(input.maxTurnsPerRound ?? ROOM_DEFAULT_TURNS);
    const pauseSeconds = Number(input.pauseSeconds ?? ROOM_DEFAULT_PAUSE);
    const creditCap = input.creditCap === null || input.creditCap === undefined ? null : Number(input.creditCap);

    if (!name) problems.push("a name is required");
    if (!cwd) problems.push("a working directory is required");
    if (!topic) problems.push("a topic is required");
    if (!Number.isInteger(maxTurnsPerRound) || maxTurnsPerRound < 1 || maxTurnsPerRound > ROOM_MAX_TURNS) {
      problems.push(`turns per round must be a whole number from 1 to ${ROOM_MAX_TURNS}`);
    }
    if (!Number.isFinite(pauseSeconds) || pauseSeconds < 0 || pauseSeconds > 60) problems.push("the pause must be 0 to 60 seconds");
    if (creditCap !== null && (!Number.isFinite(creditCap) || creditCap <= 0)) problems.push("the credit cap must be a positive number, or empty");

    const raw = Array.isArray(input.participants) ? input.participants : [];
    const participants = raw.map((p) => ({
      name: str(p?.name),
      providerId: str(p?.providerId),
      role: str(p?.role),
      start: cleanStart(p?.start),
    }));
    if (participants.length < ROOM_MIN_PARTICIPANTS || participants.length > ROOM_MAX_PARTICIPANTS) {
      problems.push(`${ROOM_MIN_PARTICIPANTS} to ${ROOM_MAX_PARTICIPANTS} participants`);
    }
    const names = new Set<string>();
    for (const p of participants) {
      if (!p.name) problems.push("every participant needs a name");
      else if (names.has(p.name.toLowerCase())) problems.push(`two participants are called ${p.name}`);
      names.add(p.name.toLowerCase());
      if (!p.role) problems.push(`${p.name || "a participant"} needs a role`);
      const provider = this.providers().find((c) => c.id === p.providerId);
      if (!provider) problems.push(`${p.name || "a participant"}: no provider '${p.providerId}'`);
      else if (this.store.lastCheck(provider.id)?.status !== "ok") problems.push(`'${provider.name}' has not passed its setup check`);
    }

    if (problems.length > 0) throw kcError("ROOM_INVALID", `The room is not valid: ${problems.join("; ")}.`);
    return { name, cwd, topic, rules, maxTurnsPerRound, pauseSeconds, creditCap, participants };
  }
}

/** The text an agent has streamed since a point in its log. */
const saidSince = (session: Session, since: number): string =>
  session
    .eventsSince(since)
    .flatMap((e) => (e.type === "agent_text" ? [e.text] : []))
    .join("")
    .trim();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isKcError = (err: unknown): err is KcError =>
  typeof err === "object" && err !== null && "code" in err && "message" in err;
