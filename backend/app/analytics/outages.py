from __future__ import annotations

from typing import Sequence

from .common import clamp, trimmed_recent
from ..models import TelemetrySample, isoformat_z


def build_outage_timeline(samples: Sequence[TelemetrySample], window_seconds: int) -> list[dict]:
    recent = trimmed_recent(samples, window_seconds)
    if not recent:
        return []

    events: list[dict] = []
    provisional_state = _classify_sample(recent[0])
    group_samples = [recent[0]]

    for sample in recent[1:]:
        sample_state = _classify_sample(sample)
        gap_seconds = (sample.timestamp - group_samples[-1].timestamp).total_seconds()
        if sample_state == provisional_state and gap_seconds <= 2.5:
            group_samples.append(sample)
            continue

        events.append(_finalize_event(provisional_state, group_samples))
        provisional_state = sample_state
        group_samples = [sample]

    events.append(_finalize_event(provisional_state, group_samples))
    return events


def _classify_sample(sample: TelemetrySample) -> str:
    if sample.drop_rate >= 1.0:
        return "LOSS"
    if sample.drop_rate >= 0.30:
        return "INSTABILITY"
    if sample.drop_rate >= 0.03:
        return "DEGRADED"
    if sample.latency_ms is None:
        return "DEGRADED"
    if sample.latency_ms >= 120.0:
        return "INSTABILITY"
    if sample.latency_ms >= 70.0:
        return "DEGRADED"
    return "OK"


def _finalize_event(provisional_state: str, samples: Sequence[TelemetrySample]) -> dict:
    start = samples[0].timestamp
    end = samples[-1].timestamp
    duration_seconds = max(1.0, (end - start).total_seconds() + 1.0)
    mean_drop = sum(sample.drop_rate for sample in samples) / len(samples)
    latency_values = [sample.latency_ms for sample in samples if sample.latency_ms is not None]
    mean_latency = (sum(latency_values) / len(latency_values)) if latency_values else None

    state = provisional_state
    if provisional_state == "LOSS":
        state = "MICRO_OUTAGE" if duration_seconds <= 2.0 else "OUTAGE"
    elif provisional_state == "DEGRADED" and mean_drop >= 0.18:
        state = "INSTABILITY"

    severity = {
        "OK": 0.1,
        "DEGRADED": 0.45,
        "INSTABILITY": 0.7,
        "MICRO_OUTAGE": 0.82,
        "OUTAGE": 1.0,
    }[state]

    return {
        "state": state,
        "start": isoformat_z(start),
        "end": isoformat_z(end),
        "duration_s": round(duration_seconds, 2),
        "sample_count": len(samples),
        "avg_drop_rate": round(mean_drop, 4),
        "avg_latency_ms": round(mean_latency, 2) if mean_latency is not None else None,
        "severity": clamp(severity, 0.0, 1.0),
    }
