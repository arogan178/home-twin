from __future__ import annotations

from pathlib import Path

import pytest

from home_twin.model import HomeTwin
from home_twin.sample import create_sample_ifc


@pytest.fixture
def sample_path(tmp_path: Path) -> Path:
    return create_sample_ifc(tmp_path / "model" / "house.ifc", with_spotlights=True)


@pytest.fixture
def twin(sample_path: Path) -> HomeTwin:
    return HomeTwin.open(sample_path)
