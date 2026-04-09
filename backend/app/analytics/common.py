from __future__ import annotations

import math
from statistics import median
from typing import Iterable, Sequence


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = clamp(q, 0.0, 1.0) * (len(ordered) - 1)
    lower_index = int(math.floor(rank))
    upper_index = int(math.ceil(rank))
    if lower_index == upper_index:
        return ordered[lower_index]
    fraction = rank - lower_index
    return ordered[lower_index] * (1.0 - fraction) + ordered[upper_index] * fraction


def trimmed_recent(values: Sequence, max_age_seconds: int):
    if not values:
        return []
    newest = values[-1].timestamp
    cutoff = newest.timestamp() - max_age_seconds
    return [item for item in values if item.timestamp.timestamp() >= cutoff]


def log_space(start: float, end: float, count: int) -> list[float]:
    if count <= 1:
        return [start, end]
    log_start = math.log10(start)
    log_end = math.log10(end)
    step = (log_end - log_start) / count
    return [10 ** (log_start + step * index) for index in range(count + 1)]


def safe_median(values: Sequence[float]) -> float:
    return median(values) if values else 0.0
