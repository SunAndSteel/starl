from __future__ import annotations

import bisect
from typing import Sequence

from .common import log_space, safe_median, trimmed_recent
from ..models import TelemetrySample


def build_bufferbloat_curve(
    samples: Sequence[TelemetrySample],
    window_seconds: int,
    bucket_count: int,
) -> list[dict]:
    recent = trimmed_recent(samples, window_seconds)
    curve_samples = [
        sample
        for sample in recent
        if sample.latency_ms is not None and sample.load_bps > 0
    ]
    if not curve_samples:
        return []

    max_load = max(sample.load_bps for sample in curve_samples)
    edges = log_space(100_000.0, max(max_load, 1_000_000.0) * 1.05, bucket_count)
    buckets: list[list[float]] = [[] for _ in range(bucket_count)]

    for sample in curve_samples:
        bucket_index = min(bucket_count - 1, max(0, bisect.bisect_right(edges, sample.load_bps) - 1))
        buckets[bucket_index].append(sample.latency_ms or 0.0)

    dataset: list[dict] = []
    for index, values in enumerate(buckets):
        if not values:
            continue
        ordered = sorted(values)
        dataset.append(
            {
                "load_min_bps": round(edges[index], 2),
                "load_max_bps": round(edges[index + 1], 2),
                "load_mid_bps": round((edges[index] * edges[index + 1]) ** 0.5, 2),
                "min_latency_ms": round(ordered[0], 2),
                "median_latency_ms": round(safe_median(ordered), 2),
                "max_latency_ms": round(ordered[-1], 2),
                "sample_count": len(ordered),
            }
        )
    return dataset
