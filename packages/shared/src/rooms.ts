/**
 * A room: two or more agents and the user, talking in turns.
 *
 * Each agent is an ordinary session; the room is the router that decides who
 * speaks next and what they are shown. ACP has no notion of agents addressing
 * each other, so "what they are shown" is a prompt: a preamble naming the
 * room, then everything said since that agent last spoke.
 */
export interface RoomParticipant {
  id: string;
  /** How the others address it: "Planner", "Critic". */
  name: string;
  providerId: string;
  /** One line of persona, put in front of every prompt it gets. */
  role: string;
  /** The conversation it speaks from, once its agent is up. */
  sessionId: string | null;
  /** The room seq it has been shown up to; its next prompt starts after this. */
  lastSeq: number;
}

export type RoomStatus =
  /** Nobody is being prompted; the next thing said starts a round. */
  | "idle"
  /** Agents are taking turns. */
  | "running"
  /** The user is typing: the current turn finishes, nobody else is prompted. */
  | "held"
  /** Stopped by the user; say something to start again. */
  | "stopped";

export interface Room {
  id: string;
  name: string;
  cwd: string;
  /** What the room is for; every agent sees it. */
  topic: string;
  participants: RoomParticipant[];
  /** Agent turns per round — a round is what one message from the user sets off. */
  maxTurnsPerRound: number;
  /** Breathing room between agent turns, so the user can get a word in. */
  pauseSeconds: number;
  /** Stop the room once the agents have spent this many credits, where they report it. */
  creditCap: number | null;
  status: RoomStatus;
  /** Credits the agents have reported spending, summed. */
  creditsUsed: number;
  createdAt: number;
  updatedAt: number;
}

export type RoomInput = Pick<Room, "name" | "cwd" | "topic" | "maxTurnsPerRound" | "pauseSeconds" | "creditCap"> & {
  participants: Array<Pick<RoomParticipant, "name" | "providerId" | "role">>;
};

/** One thing said in the room, by an agent or the user. Append-only, like every log here. */
export interface RoomMessage {
  id: string;
  roomId: string;
  seq: number;
  ts: number;
  /** A participant id, or "user". */
  speaker: string;
  name: string;
  text: string;
}

export interface RoomView extends Room {
  messages: RoomMessage[];
  /** Participant ids whose agent is attached right now. The rest re-attach when spoken to, or on Reconnect. */
  live: string[];
  /** Which participant is being prompted right now, if any. */
  speaking: string | null;
  /** What it has said so far this turn — its reply, streaming. */
  speakingText: string;
  /** Agent turns taken in the current round. */
  turnsThisRound: number;
}

export const ROOM_USER = "user";
export const ROOM_MIN_PARTICIPANTS = 2;
export const ROOM_MAX_PARTICIPANTS = 6;
export const ROOM_DEFAULT_TURNS = 6;
export const ROOM_MAX_TURNS = 50;
export const ROOM_DEFAULT_PAUSE = 2;
/** What an agent says to yield its turn. */
export const ROOM_PASS = "PASS";
