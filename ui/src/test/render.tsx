import { QueryClientProvider } from "@tanstack/react-query";
import { render as renderWithoutClient, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { createQueryClient } from "../queryClient";

// A fresh client per render, so no test reads another test's cache.
export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderWithoutClient(ui, { ...options, wrapper });
}
