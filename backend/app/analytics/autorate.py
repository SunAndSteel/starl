from __future__ import annotations

from collections import deque

from .common import clamp


CAKE_LATENCY_TARGET = 45.0
CAKE_DROP_TARGET = 0.005
CAKE_MIN_DOWN = 5_000_000
CAKE_MAX_DOWN = 250_000_000
CAKE_MIN_UP = 1_000_000
CAKE_MAX_UP = 25_000_000
CAKE_PROBE_STEP = 0.03
CAKE_REDUCE_MILD = 0.08
CAKE_REDUCE_HARD = 0.20


class AutorateAdvisor:
    """Small state machine derived from the terminal autorate logic."""

    def __init__(self) -> None:
        self.down_bps = CAKE_MIN_DOWN * 4
        self.up_bps = CAKE_MIN_UP * 4
        self.phase = "INIT"
        self.reason = "warming up"
        self.cooldown = 0
        self.latency_window = deque(maxlen=8)
        self.drop_window = deque(maxlen=8)

    def update(self, latency_ms: float | None, drop_rate: float | None) -> None:
        if latency_ms is None:
            return

        drop_rate = drop_rate or 0.0
        self.latency_window.append(latency_ms)
        self.drop_window.append(drop_rate)
        if len(self.latency_window) < self.latency_window.maxlen:
            self.phase = "WARMUP"
            self.reason = "collecting baseline"
            return

        avg_latency = sum(self.latency_window) / len(self.latency_window)
        avg_drop = sum(self.drop_window) / len(self.drop_window)
        score = clamp(
            1.0 - ((avg_latency / CAKE_LATENCY_TARGET) * 0.7 + (avg_drop / CAKE_DROP_TARGET) * 0.3),
            -1.0,
            1.0,
        )

        if self.cooldown > 0:
            self.cooldown -= 1
            self.phase = "HOLD"
            self.reason = "cooldown"
            return

        if avg_latency > CAKE_LATENCY_TARGET * 1.3 or avg_drop > CAKE_DROP_TARGET * 3.0:
            self.down_bps *= 1.0 - CAKE_REDUCE_HARD
            self.up_bps *= 1.0 - CAKE_REDUCE_HARD
            self.phase = "THROTTLE"
            self.reason = f"hard bloat at {avg_latency:.0f} ms"
            self.cooldown = 2
        elif avg_latency > CAKE_LATENCY_TARGET or avg_drop > CAKE_DROP_TARGET * 2.0:
            self.down_bps *= 1.0 - CAKE_REDUCE_MILD
            self.up_bps *= 1.0 - CAKE_REDUCE_MILD
            self.phase = "BACKOFF"
            self.reason = f"soft bloat at {avg_latency:.0f} ms"
        else:
            self.down_bps *= 1.0 + CAKE_PROBE_STEP * (1.0 + max(0.0, score))
            self.up_bps *= 1.0 + CAKE_PROBE_STEP * (1.0 + max(0.0, score))
            self.phase = "PROBE"
            self.reason = f"healthy window score {score:.2f}"

        self.down_bps = clamp(self.down_bps, CAKE_MIN_DOWN, CAKE_MAX_DOWN)
        self.up_bps = clamp(self.up_bps, CAKE_MIN_UP, CAKE_MAX_UP)

    def snapshot(self) -> dict:
        return {
            "phase": self.phase,
            "reason": self.reason,
            "recommended_downlink_bps": round(self.down_bps, 2),
            "recommended_uplink_bps": round(self.up_bps, 2),
        }
