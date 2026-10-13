import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { TRACE_SHORTCUTS } from "./traceShortcuts";

describe("TRACE_SHORTCUTS", () => {
  it("is mirrored row for row by the Shortcuts section of docs/tracing.md", () => {
    const docs = readFileSync(resolve(process.cwd(), "../docs/tracing.md"), "utf8");
    const section = docs.split("\n### Shortcuts\n")[1]?.split("\n#")[0] ?? "";
    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Keys |"))
      .map((line) => line.slice(2, -2).split(" | "));
    expect(rows).toEqual(TRACE_SHORTCUTS.map((item) => [item.keys, item.action]));
  });
});
