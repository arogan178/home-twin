/**
 * Save the 3D view as a PNG that carries its own disclaimer.
 *
 * A rendered pool of light is an approximation, and a picture of one keeps the
 * same method label and disclaimer as the numbers behind it. The caption is
 * drawn into the image rather than beside it, so it survives being forwarded.
 */

export function snapshotFilename(label: string, when: Date): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "view";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `home-twin-${slug}-${stamp}.png`;
}

/** Split caption text into lines that fit `maxWidth` pixels. */
export function wrapCaption(
  lines: ReadonlyArray<string>,
  maxWidth: number,
  measure: (text: string) => number,
): string[] {
  const wrapped: string[] = [];
  for (const line of lines) {
    let current = "";
    for (const word of line.split(/\s+/).filter(Boolean)) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (current !== "" && measure(candidate) > maxWidth) {
        wrapped.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current !== "") wrapped.push(current);
  }
  return wrapped;
}

/** The rendered frame with a caption band beneath it. */
export function captionedCanvas(source: HTMLCanvasElement, caption: ReadonlyArray<string>): HTMLCanvasElement {
  const width = source.width;
  const scale = Math.max(1, width / 1400);
  const fontSize = Math.round(12 * scale);
  const padding = Math.round(14 * scale);
  const lineHeight = Math.round(fontSize * 1.5);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser cannot compose a snapshot");
  const font = `${fontSize}px "IBM Plex Mono Variable", monospace`;
  context.font = font;
  const lines = wrapCaption(caption, width - padding * 2, (text) => context.measureText(text).width);
  canvas.width = width;
  canvas.height = source.height + padding * 2 + lines.length * lineHeight;
  context.fillStyle = "#f5f8f7";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  context.font = font;
  context.fillStyle = "#415968";
  context.textBaseline = "top";
  lines.forEach((line, index) => {
    context.fillText(line, padding, source.height + padding + index * lineHeight);
  });
  return canvas;
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = filename;
  link.click();
}
