"""Small command-line interface for local inspection and export."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from home_twin.measurement import parse_readings
from home_twin.model import HomeTwin
from home_twin.plan_draft import build_draft, review_plan_file


def main() -> None:
    parser = argparse.ArgumentParser(prog="home-twin")
    parser.add_argument("--model", type=Path, default=Path("model/house.ifc"))
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("info")
    export = subcommands.add_parser("export-lighting")
    export.add_argument("--room", default=None)
    plan_help = "Plan source; defaults to model/references/plan.yaml, or m1-plan.yaml when only that exists"
    review = subcommands.add_parser("review-plan", aliases=["review-m1-plan"])
    review.add_argument("--project-root", type=Path, default=Path.cwd())
    review.add_argument("--plan", type=Path, default=None, help=plan_help)
    build = subcommands.add_parser("build-draft", aliases=["build-m1-draft"])
    build.add_argument("--project-root", type=Path, default=Path.cwd())
    build.add_argument("--plan", type=Path, default=None, help=plan_help)
    build.add_argument("--replace-revision", default=None)
    build.add_argument("--discard-fixtures", action="store_true")
    measured = subcommands.add_parser("compare-measurements")
    measured.add_argument("--room", required=True)
    measured.add_argument("--readings", type=Path, required=True)
    args = parser.parse_args()

    if args.command in {"review-plan", "review-m1-plan"}:
        print(json.dumps(asdict(review_plan_file(args.project_root, args.plan)), indent=2))
        return
    if args.command in {"build-draft", "build-m1-draft"}:
        report = build_draft(
            args.project_root,
            plan=args.plan,
            replace_revision=args.replace_revision,
            discard_fixtures=args.discard_fixtures,
        )
        print(json.dumps(asdict(report), indent=2, default=str))
        return

    twin = HomeTwin.open(args.model)
    if args.command == "info":
        print(json.dumps(asdict(twin.get_building()), indent=2))
        print(json.dumps([asdict(room) for room in twin.get_rooms()], indent=2))
    elif args.command == "export-lighting":
        for path in twin.export_lighting(room_id=args.room):
            print(path)
    elif args.command == "compare-measurements":
        readings = parse_readings(args.readings.read_text(encoding="utf-8"))
        comparison = twin.compare_measurements(args.room, readings)
        print(json.dumps(asdict(comparison), indent=2))


if __name__ == "__main__":
    main()
