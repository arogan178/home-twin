import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "./api";
import { localInstant } from "./DaylightPanel";
import { useLoadState } from "./queryClient";
import type { DaylightResponse, LoadState, RoomId } from "./types";

const LOADING: LoadState<never> = { kind: "loading" };

/**
 * Direct-sun geometry for a room at a local date and time. The request trails
 * the inputs by 140 ms, so dragging the time slider does not fetch every step.
 */
export function useDaylight(
  roomId: RoomId | null,
  revision: string | null,
  sunDate: string,
  sunMinutes: number,
  sunPlane: "floor" | "task",
  enabled: boolean,
): LoadState<DaylightResponse> {
  // Sun geometry depends only on the model, the site, and the chosen instant.
  const sunAt = localInstant(sunDate, sunMinutes);
  const [sunRequest, setSunRequest] = useState({ roomId, at: sunAt, plane: sunPlane });
  useEffect(() => {
    const timer = window.setTimeout(() => setSunRequest({ roomId, at: sunAt, plane: sunPlane }), 140);
    return () => window.clearTimeout(timer);
  }, [roomId, sunAt, sunPlane]);
  const daylightQuery = useQuery({
    queryKey: ["daylight", sunRequest.roomId, revision, sunRequest.at, sunRequest.plane],
    queryFn: ({ signal }) => api.daylight(sunRequest.roomId!, sunRequest.at, sunRequest.plane, signal),
    enabled: sunRequest.roomId !== null && revision !== null && enabled,
    staleTime: Infinity,
  });
  const fetchedDaylight = useLoadState(daylightQuery);
  const sunSettled = sunRequest.roomId === roomId && sunRequest.at === sunAt && sunRequest.plane === sunPlane;
  return sunSettled ? fetchedDaylight : LOADING;
}
