from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import ifcopenshell
import pytest
from fastapi.testclient import TestClient

from home_twin.exports import export_lighting
from home_twin.fixtures import PlannedRopeLight, RoomLightingDesign, RopeLightSpec
from home_twin.model import HomeTwin, Point3D
from home_twin.ui_server import build_app


@pytest.mark.parametrize("name", ["=1+1", "+SUM(1,2)", "-1+1", "@SUM(1,2)", "  =1+1", "\tName"])
def test_csv_neutralizes_imported_formulas_without_changing_model_or_json(sample_path: Path, name: str) -> None:
    model = ifcopenshell.open(sample_path)
    model.by_type("IfcSpace")[0].Name = name
    model.write(sample_path)
    original = sample_path.read_bytes()
    client = TestClient(build_app(sample_path), base_url="http://127.0.0.1")
    assert client.post("/api/exports").status_code == 200

    response = client.get("/api/exports/lighting-layout.csv")
    rows = list(csv.DictReader(io.StringIO(response.text)))
    assert rows[0]["room"] == "'" + name
    assert rows[0]["x_mm"] == "1500"
    data = json.loads(client.get("/api/exports/lighting-layout.json").text)
    assert data["fixtures"][0]["room"] == name
    assert sample_path.read_bytes() == original


def test_csv_preserves_negative_building_coordinates(twin: HomeTwin, tmp_path: Path) -> None:
    room_id = twin.get_rooms()[0].id
    rope = PlannedRopeLight(
        "RL01",
        room_id,
        (Point3D(-1200, -500, 2800), Point3D(-600, 500, 2800)),
        RopeLightSpec(),
        "ROPE",
    )
    paths = export_lighting(
        twin.revision,
        (RoomLightingDesign(room_id, (rope,)),),
        {room_id: twin.get_room_context(room_id)},
        tmp_path,
        frozenset({"csv"}),
    )
    rows = list(csv.DictReader(io.StringIO(paths[0].read_text())))
    assert rows[0]["x_mm"] == "-1200"
    assert rows[0]["y_mm"] == "-500"
    assert rows[0]["path_mm"] == "-1200,-500,2800 | -600,500,2800"
