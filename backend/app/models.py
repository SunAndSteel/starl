from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(slots=True)
class TelemetrySample:
    timestamp: datetime
    latency_ms: Optional[float]
    drop_rate: float
    downlink_bps: float
    uplink_bps: float
    dish_state: str

    @property
    def load_bps(self) -> float:
        return max(0.0, self.downlink_bps) + max(0.0, self.uplink_bps)


def isoformat_z(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")
