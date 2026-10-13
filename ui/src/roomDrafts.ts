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


/** Every device tag outside `roomId`, saved or still an unsaved draft in this session. */
export function tagsOutsideRoom(
  plan: WholePlan,
  drafts: RoomDrafts,
  roomId: RoomId,
): ReadonlyArray<{ readonly tag: string }> {
  return mergeRoomDrafts(plan, drafts)
    .rooms.filter((entry) => entry.room.id !== roomId)
    .flatMap((entry) => [...entry.fixtures, ...entry.switches, ...entry.sensors]);
}
