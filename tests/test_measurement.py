"""Meter readings held against the predicted surface."""

from __future__ import annotations

import pytest

from home_twin.measurement import (
    Reading,
    compare_measurements,
    parse_readings,
)
from home_twin.model import HomeTwin, Point3D


def test_readings_parse_from_the_installation_frame() -> None:
    readings = parse_readings(
        "x_mm,y_mm,z_mm,measured_lux,note\n"
        "1000,2000,800,145.2,under SP01\n"
        "3000,2000,800,88,between fixtures\n"
    )

    assert [reading.measured_lux for reading in readings] == [145.2, 88.0]
    assert readings[0].point == Point3D(1000.0, 2000.0, 800.0)
    assert readings[0].note == "under SP01"


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("x_mm,y_mm,z_mm\n1,2,3\n", "measured_lux"),
        ("x_mm,y_mm,z_mm,measured_lux\n", "no rows"),
        ("x_mm,y_mm,z_mm,measured_lux\n1,2,3,dim\n", "must be a number"),
        ("x_mm,y_mm,z_mm,measured_lux\n1,2,3,-5\n", "cannot be negative"),
    ],
)
def test_unusable_readings_are_rejected_with_the_reason(text: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        parse_readings(text)


def test_the_bias_is_signed_so_a_consistent_overshoot_is_visible() -> None:
    """40 lx high everywhere is a different fault from 40 lx out in both directions."""

    readings = (
        Reading(Point3D(0, 0, 800), 100.0),
        Reading(Point3D(1000, 0, 800), 200.0),
    )

    optimistic = compare_measurements("ROOM", readings, (140.0, 240.0), "test_method")
    assert optimistic.mean_bias_lux == pytest.approx(40.0)
    assert optimistic.mean_absolute_error_lux == pytest.approx(40.0)

    scattered = compare_measurements("ROOM", readings, (140.0, 160.0), "test_method")
    assert scattered.mean_bias_lux == pytest.approx(0.0)
    assert scattered.mean_absolute_error_lux == pytest.approx(40.0)


def test_the_worst_reading_is_the_largest_absolute_miss() -> None:
    readings = (
        Reading(Point3D(0, 0, 800), 100.0),
        Reading(Point3D(1000, 0, 800), 100.0, "behind the cabinet"),
    )

    comparison = compare_measurements("ROOM", readings, (105.0, 30.0), "test_method")

    assert comparison.worst is not None
    assert comparison.worst.note == "behind the cabinet"
    assert comparison.worst.difference_lux == pytest.approx(-70.0)
    assert comparison.worst.ratio == pytest.approx(0.3)


def test_a_reading_of_zero_reports_no_ratio() -> None:
    comparison = compare_measurements("ROOM", (Reading(Point3D(0, 0, 800), 0.0),), (12.0,), "test")
    assert comparison.residuals[0].ratio is None
    assert comparison.residuals[0].difference_lux == pytest.approx(12.0)


def test_a_mismatched_prediction_count_is_refused() -> None:
    with pytest.raises(ValueError, match="exactly one prediction"):
        compare_measurements("ROOM", (Reading(Point3D(0, 0, 800), 10.0),), (1.0, 2.0), "test")


def test_the_comparison_predicts_at_the_measured_point(twin: HomeTwin) -> None:
    """A reading under a fixture must beat one in the corner of the same room."""

    room = twin.get_rooms()[0]
    layout = twin.get_lighting_layout(room.id)
    assert layout.fixtures, "the sample model ships with spotlights"
    under = layout.fixtures[0].point

    comparison = twin.compare_measurements(
        room.id,
        (
            Reading(Point3D(under.x, under.y, 800.0), 150.0),
            Reading(Point3D(200.0, 200.0, 800.0), 150.0),
        ),
    )

    assert comparison.room_id == room.id
    assert comparison.prediction_method.startswith(("direct_occluded", "ies_lm63"))
    assert comparison.residuals[0].predicted_lux > comparison.residuals[1].predicted_lux
