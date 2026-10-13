import type { Fixture, RoomId, WallSwitch, WholePlan } from "./types";

export type RoomLightingDraft = {
  readonly fixtures: ReadonlyArray<Fixture>;
  readonly switches: ReadonlyArray<WallSwitch>;
};

export type RoomDrafts = Readonly<Record<string, RoomLightingDraft>>;

export function withRoomDraft(
  drafts: RoomDrafts,
  roomId: RoomId,
  draft: RoomLightingDraft,
): RoomDrafts {
  return { ...drafts, [roomId]: draft };
}

export function withoutRoomDraft(drafts: RoomDrafts, roomId: RoomId): RoomDrafts {
  const next = { ...drafts };
  delete next[roomId];
  return next;
}

export function mergeRoomDrafts(plan: WholePlan, drafts: RoomDrafts): WholePlan {
  return {
    ...plan,
    rooms: plan.rooms.map((entry) => {
      const draft = drafts[entry.room.id];
      return draft === undefined
        ? entry
        : { ...entry, fixtures: [...draft.fixtures], switches: [...draft.switches] };
    }),
  };
}

