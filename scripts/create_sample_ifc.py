#!/usr/bin/env python3
"""Generate model/house.ifc for the demo repository."""

from __future__ import annotations

import argparse
from pathlib import Path

from home_twin.sample import create_sample_ifc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", type=Path, default=Path("model/house.ifc"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    print(create_sample_ifc(args.path, overwrite=args.force))


if __name__ == "__main__":
    main()

