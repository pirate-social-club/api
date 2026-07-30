from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class CalibrationArtifact:
    version: str
    raw_knots: tuple[float, ...]
    score_bps_knots: tuple[int, ...]
    admitted: bool

    @property
    def checksum(self) -> str:
        payload = json.dumps(
            {
                "version": self.version,
                "raw_knots": self.raw_knots,
                "score_bps_knots": self.score_bps_knots,
                "admitted": self.admitted,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode()).hexdigest()

    def score(self, raw_similarity: float) -> int:
        value = np.interp(raw_similarity, self.raw_knots, self.score_bps_knots)
        return round(np.clip(value, 0, 10_000))


def provisional_calibration() -> CalibrationArtifact:
    return CalibrationArtifact(
        version="dance_calibration_gate0_provisional_v1",
        raw_knots=(0.0, 0.35, 0.55, 0.72, 0.86, 1.0),
        score_bps_knots=(0, 1000, 3500, 6000, 8200, 10_000),
        admitted=False,
    )
