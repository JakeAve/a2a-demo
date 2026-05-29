// Shared types for the Room Broker and its clients. The broker owns the
// canonical copies in its own KV; agents only ever see snapshots.

export type MemberKind = "agent" | "human";

export type Member = {
  name: string;
  inboxUrl: string;   // broker pushes deliveries to `${inboxUrl}/inbox`
  kind: MemberKind;
  active: boolean;    // false after leave()
  joinedAt: number;
};

export type RoomRecord = {
  roomId: string;
  title: string;
  createdBy: string;
  status: "open" | "closed";
  members: Member[];
  turnCount: number;     // total posts; checked against maxTurns
  maxTurns: number;
  lastActivityAt: number;
  sessionId: string;     // monitor session that owns this room
};

export type TranscriptMessage = {
  seq: number;
  roomId: string;
  from: string;
  to: string[];
  text: string;
  ts: number;
};

export type Delivery = {
  turnId: string;        // == delivery id
  roomId: string;
  member: string;        // recipient
  addressedBy: string;   // poster who triggered it
  createdAt: number;
  deadline: number;      // sweep resolves pending deliveries past this
  status: "pending" | "resolved";
};

// Mutable per-agent holder, set by the inbox consumer before a room-turn and
// read by the `post` tool to attach the correct turnId. Safe to mutate in
// place because the inbox consumer runs one delivery at a time.
export type RoomTurnState = {
  active: null | {
    roomId: string;
    turnId: string;
    addressedBy: string;
    posted: boolean;
  };
};

// Payload the broker pushes to an agent's /inbox.
export type InboxDelivery = {
  roomId: string;
  turnId: string;
  addressedBy: string;
  title: string;
  members: string[];          // active member names
  transcript: TranscriptMessage[];
  sessionId?: string;         // room's monitor session; enables agent turn events to flow
};

// Body of POST /rooms/:id/post
export type PostInput = {
  from: string;
  text: string;
  to: string[];
  turnId?: string;
};
