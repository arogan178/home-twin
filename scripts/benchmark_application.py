#!/usr/bin/env python3
"""Measure read-only browser API latency and transferred bytes on a running server."""

from __future__ import annotations

import argparse
import gzip
import json
import statistics
import time
import urllib.request
from pathlib import Path


def measure(url: str, samples: int, encoding: str) -> list[dict]:
    def read(endpoint: str) -> tuple[bytes, int, float]:
        request = urllib.request.Request(url.rstrip("/") + endpoint, headers={"Accept-Encoding": encoding})
        start = time.perf_counter()
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()
            transferred = len(body)
            if response.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
        return body, transferred, (time.perf_counter() - start) * 1000

    project = json.loads(read("/api/project")[0])
    endpoints = ["/api/project", "/api/plan"]
    if project["rooms"]:
        endpoints.append(f"/api/rooms/{project['rooms'][0]['id']}/design")
    results = []
    for endpoint in endpoints:
        timings = []
        for _ in range(samples):
            body, transferred, elapsed = read(endpoint)
            timings.append(elapsed)
        results.append(
            {
                "endpoint": endpoint,
                "median_ms": round(statistics.median(timings), 3),
                "samples_ms": timings,
                "body_bytes": len(body),
                "transferred_bytes": transferred,
            }
        )
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8123")
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--encoding", choices=("identity", "gzip"), default="gzip")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be positive")
    result = json.dumps(measure(args.url, args.samples, args.encoding), indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result)
    print(result, end="")


if __name__ == "__main__":
    main()
