"""Draw the demo plan's outlines into underlay.png, reproducibly, using only the stdlib and PyYAML."""

import struct
import zlib
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
INK = {"rooms": 0, "stairs": 110, "daylight_sources": 170}


def png(width: int, height: int, rows: list[bytearray]) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)  # 8-bit greyscale
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main() -> None:
    plan = yaml.safe_load((HERE / "plan.yaml").read_text())
    underlay = plan["underlay"]
    width, height, scale = underlay["width_px"], underlay["height_px"], underlay["mm_per_px"]
    origin = underlay["origin_px"]
    rows = [bytearray(b"\xff" * width) for _ in range(height)]

    def pixel(point_id: str) -> tuple[float, float]:
        point = plan["points"][point_id]
        return origin["x"] + point["x_mm"] / scale, origin["y"] - point["y_mm"] / scale

    def line(start: tuple[float, float], end: tuple[float, float], ink: int) -> None:
        steps = int(max(abs(end[0] - start[0]), abs(end[1] - start[1]))) + 1
        for step in range(steps + 1):
            x = round(start[0] + (end[0] - start[0]) * step / steps)
            y = round(start[1] + (end[1] - start[1]) * step / steps)
            for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
                if 0 <= x + dx < width and 0 <= y + dy < height:
                    rows[y + dy][x + dx] = min(rows[y + dy][x + dx], ink)

    for section, ink in INK.items():
        for item in plan.get(section, []):
            ids = item["point_ids"]
            for first, second in zip(ids, ids[1:] + ids[:1], strict=True):
                line(pixel(first), pixel(second), ink)

    (HERE / "underlay.png").write_bytes(png(width, height, rows))


if __name__ == "__main__":
    main()
