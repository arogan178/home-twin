import { LayoutGrid, Ruler } from "lucide-react";

import { orderedRooms, roomDisplayName, roomSequenceNumber } from "./roomOrder";
import type { PlanScope, Room, RoomId } from "./types";

export function RoomRail({
  rooms,
  roomId,
  scope,
  onSelectWholeFloor,
  onSelectRoom,
}: {
  readonly rooms: ReadonlyArray<Room>;
  readonly roomId: RoomId | null;
  readonly scope: PlanScope;
  readonly onSelectWholeFloor: () => void;
  readonly onSelectRoom: (roomId: RoomId) => void;
}) {
  return (
    <aside className="room-rail">
      <h2 className="rail-heading">Rooms</h2>
      <button
        type="button"
        className={scope === "whole" ? "room-button room-button--active" : "room-button"}
        aria-current={scope === "whole" ? "page" : undefined}
        onClick={onSelectWholeFloor}
      >
        <span className="room-index"><LayoutGrid size={14} /></span>
        <span><strong>Whole floor</strong><small>Every room at once</small></span>
      </button>
      <nav aria-label="Rooms">
        {/* A level of a room is listed under it, not beside it: the entrance
            landing is the open plan's lower level, not a ninth room. */}
        {orderedRooms(rooms).map((room) => {
          const active = room.id === roomId && scope === "room";
          const parent = room.part_of ? rooms.find((item) => item.id === room.part_of) : undefined;
          const className = [
            "room-button",
            active ? "room-button--active" : "",
            parent ? "room-button--level" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={room.id}
              type="button"
              className={className}
              aria-current={active ? "page" : undefined}
              onClick={() => onSelectRoom(room.id)}
            >
              <span className="room-index" aria-hidden={parent ? true : undefined}>{parent ? "└" : String(roomSequenceNumber(rooms, room)).padStart(2, "0")}</span>
              <span title={parent ? `${roomDisplayName(room)}, lower level of ${roomDisplayName(parent)}` : undefined}>
                <strong>{roomDisplayName(room)}</strong>
                <small>
                  {parent
                    ? "Lower level"
                    : room.is_external
                      ? "Outdoor"
                      : `${Math.round(room.bounds.maximum.z - room.elevation_mm)} mm high`}
                </small>
              </span>
            </button>
          );
        })}
      </nav>
      <div className="rail-foot">
        <Ruler size={14} />
        <p>Plan dimensions are building millimetres.</p>
      </div>
    </aside>
  );
}
