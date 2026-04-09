from __future__ import annotations

import math
from statistics import mean, pstdev
from typing import Sequence

from .common import clamp, percentile, trimmed_recent
from ..models import TelemetrySample


def compute_optimal_throughput(
    samples: Sequence[TelemetrySample],
    window_seconds: int,
    latency_threshold_ms: float = 60.0,
    drop_threshold: float = 0.02,
) -> dict:
    recent = trimmed_recent(samples, window_seconds)
    latest = recent[-1] if recent else None

    valid = [
        sample
        for sample in recent
        if sample.latency_ms is not None
        and sample.latency_ms < latency_threshold_ms
        and sample.drop_rate < drop_threshold
    ]

    down_values = [sample.downlink_bps for sample in valid if sample.downlink_bps > 0]
    up_values = [sample.uplink_bps for sample in valid if sample.uplink_bps > 0]

    filtered_down, rejected_down = _reject_spikes(down_values)
    filtered_up, rejected_up = _reject_spikes(up_values)

    optimal_down = percentile(filtered_down, 0.9) if filtered_down else 0.0
    optimal_up = percentile(filtered_up, 0.9) if filtered_up else 0.0

    coverage = len(valid) / max(1, len(recent))
    latency_headroom = _latency_headroom(valid, latency_threshold_ms)
    loss_headroom = _loss_headroom(valid, drop_threshold)
    variability_penalty = _variability_penalty(filtered_down + filtered_up)
    confidence = clamp(
        0.45 * coverage + 0.2 * latency_headroom + 0.2 * loss_headroom + 0.15 * variability_penalty,
        0.0,
        1.0,
    )

    return {
        "window_seconds": window_seconds,
        "thresholds": {
            "latency_ms": latency_threshold_ms,
            "drop_rate": drop_threshold,
        },
        "current": {
            "downlink_bps": latest.downlink_bps if latest else 0.0,
            "uplink_bps": latest.uplink_bps if latest else 0.0,
        },
        "optimal": {
            "downlink_bps": round(optimal_down, 2),
            "uplink_bps": round(optimal_up, 2),
        },
        "confidence": round(confidence, 3),
        "sample_count": len(recent),
        "valid_sample_count": len(valid),
        "rejected_spikes": rejected_down + rejected_up,
    }


def _reject_spikes(values: Sequence[float]) -> tuple[list[float], int]:
    if len(values) < 4:
        return list(values), 0
    q1 = percentile(values, 0.25)
    q3 = percentile(values, 0.75)
    iqr = max(1.0, q3 - q1)
    upper_bound = q3 + iqr * 1.5
    filtered = [value for value in values if value <= upper_bound]
    return filtered, len(values) - len(filtered)


def _latency_headroom(samples: Sequence[TelemetrySample], threshold: float) -> float:
    if not samples:
        return 0.0
    return clamp(mean(max(0.0, 1.0 - (sample.latency_ms or threshold) / threshold) for sample in samples), 0.0, 1.0)


def _loss_headroom(samples: Sequence[TelemetrySample], threshold: float) -> float:
    if not samples:
        return 0.0
    return clamp(mean(max(0.0, 1.0 - sample.drop_rate / max(threshold, 1e-6)) for sample in samples), 0.0, 1.0)


def _variability_penalty(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.75 if values else 0.0
    average = mean(values)
    if average <= 0:
        return 0.0
    coefficient = pstdev(values) / average
    return clamp(1.0 / (1.0 + coefficient * 3.0), 0.0, 1.0)
