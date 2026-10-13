import { QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";

import type { LoadState } from "./types";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, retry: false },
    },
  });
}

// A retry after an error reads as loading again, as the hand-rolled loaders did.
export function useLoadState<T>(query: UseQueryResult<T>, fallbackMessage = "The request failed"): LoadState<T> {
  const { status, data, error } = query;
  const retrying = status === "error" && query.isFetching;
  return useMemo((): LoadState<T> => {
    if (status === "success") return { kind: "ready", value: data as T };
    if (status === "error" && !retrying) {
      return { kind: "error", message: error instanceof Error ? error.message : fallbackMessage };
    }
    return { kind: "loading" };
  }, [status, data, error, retrying, fallbackMessage]);
}
