from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import starlink_grpc

from .config import Settings
from .models import TelemetrySample


@dataclass(slots=True)
class PollBatch:
    status: dict
    alerts: dict
    samples: list[TelemetrySample]
    error: Optional[str]


class StarlinkCollector:
    """Blocking Starlink gRPC collector kept off the FastAPI event loop."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.context = starlink_grpc.ChannelContext(target=settings.starlink_target)
        self.last_counter: Optional[int] = None

    def poll(self, now: Optional[datetime] = None) -> PollBatch:
        timestamp = now or datetime.now(timezone.utc)
        errors: list[str] = []
        status: dict = {}
        alerts: dict = {}
        samples: list[TelemetrySample] = []

        try:
            status, _, alerts = starlink_grpc.status_data(context=self.context)
        except Exception as exc:
            errors.append(f"status_data: {exc}")

        try:
            general, bulk = starlink_grpc.history_bulk_data(
                parse_samples=self.settings.parse_samples,
                start=self.last_counter,
                context=self.context,
            )
            self.last_counter = general.get("end_counter")
            samples = self._to_samples(timestamp, bulk, status, int(general.get("samples", 0)))
        except Exception as exc:
            errors.append(f"history_bulk_data: {exc}")

        return PollBatch(
            status=status,
            alerts=alerts,
            samples=samples,
            error=" | ".join(errors) if errors else None,
        )

    def close(self) -> None:
        self.context.close()

    def _to_samples(self, now: datetime, bulk: dict, status: dict, sample_count: int) -> list[TelemetrySample]:
        samples: list[TelemetrySample] = []
        latencies = bulk.get("pop_ping_latency_ms", [])
        drops = bulk.get("pop_ping_drop_rate", [])
        downs = bulk.get("downlink_throughput_bps", [])
        ups = bulk.get("uplink_throughput_bps", [])
        dish_state = status.get("state", "UNKNOWN")

        for index in range(sample_count):
            sample_time = now - timedelta(seconds=(sample_count - index - 1))
            samples.append(
                TelemetrySample(
                    timestamp=sample_time,
                    latency_ms=latencies[index] if index < len(latencies) else None,
                    drop_rate=float(drops[index] if index < len(drops) else 0.0),
                    downlink_bps=float(downs[index] if index < len(downs) and downs[index] is not None else 0.0),
                    uplink_bps=float(ups[index] if index < len(ups) and ups[index] is not None else 0.0),
                    dish_state=dish_state,
                )
            )
        return samples
