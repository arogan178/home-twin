import type { Room } from "./types";

export function roomDisplayName(room: Room): string {
  return room.name.replace(/open\s*plan/i, "Open plan");
}

export function orderedRooms(rooms: ReadonlyArray<Room>): Room[] {
  const roomById = new Map<string, Room>(rooms.map((room) => [room.id, room]));
  const rootName = (room: Room) => {
    const parent = room.part_of ? roomById.get(room.part_of) : undefined;
    return roomDisplayName(parent ?? room);
  };
  const priority = (room: Room) => (/^open plan$/i.test(rootName(room)) ? 0 : room.is_external ? 2 : 1);

  return [...rooms].sort((a, b) => {
    const byPriority = priority(a) - priority(b);
    if (byPriority !== 0) return byPriority;
    const byRoot = rootName(a).localeCompare(rootName(b));
    if (byRoot !== 0) return byRoot;
    if (Boolean(a.part_of) !== Boolean(b.part_of)) return a.part_of ? 1 : -1;
    return roomDisplayName(a).localeCompare(roomDisplayName(b));
  });
}

export function roomSequenceNumber(rooms: ReadonlyArray<Room>, room: Room): number | null {
  if (room.part_of) return null;
  return orderedRooms(rooms).filter((candidate) => !candidate.part_of).findIndex((candidate) => candidate.id === room.id) + 1;
}
