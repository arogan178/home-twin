import { describe, expect, it } from "vitest";

import { orderedRooms, roomDisplayName, roomSequenceNumber } from "./roomOrder";
import { RoomIdSchema } from "./types";

const room = (id: string, name: string, partOf?: string, isExternal = false) => ({
  id: RoomIdSchema.parse(id),
  name,
  storey_id: "S",
  elevation_mm: 0,
  bounds: {
    minimum: { x: 0, y: 0, z: 0 },
    maximum: { x: 1, y: 1, z: 1 },
  },
  is_external: isExternal,
  part_of: partOf,
});

describe("room ordering", () => {
  it("puts the open plan first and its lower level directly beneath it", () => {
    const values = orderedRooms([
      room("bath", "Bathroom"),
      room("landing", "Entrance landing", "open"),
      room("yard", "Yard", undefined, true),
      room("open", "OpenPlan"),
    ]);

    expect(values.map((value) => value.id)).toEqual(["open", "landing", "bath", "yard"]);
    expect(roomDisplayName(values[0]!)).toBe("Open plan");
    expect(roomSequenceNumber(values, values[0]!)).toBe(1);
    expect(roomSequenceNumber(values, values[1]!)).toBeNull();
    expect(roomSequenceNumber(values, values[2]!)).toBe(2);
  });
});
