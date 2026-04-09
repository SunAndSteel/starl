from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime, timezone
import threading
import time
from typing import Optional

from monitor_service import MonitorService

from .analytics.autorate import AutorateAdvisor
from .analytics.bufferbloat import build_bufferbloat_curve
from .analytics.outages import build_outage_timeline
from .analytics.throughput import compute_optimal_throughput
from .config import Settings
from .ingestion import StarlinkCollector
from .models import TelemetrySample, isoformat_z
from .transport import WebSocketHub


class TelemetryService:
    def __init__(self, settings: Settings, hub: WebSocketHub, sky_monitor: Optional[MonitorService] = None) -> None:
        self.settings = settings
        self.hub = hub
        self.sky_monitor = sky_monitor
        self.collector = StarlinkCollector(settings)
        self.autorate = AutorateAdvisor()
        self.samples: deque[TelemetrySample] = deque(maxlen=settings.sample_buffer_size)
        self.status: dict = {}
        self.alerts: dict = {}
        self.last_error: Optional[str] = None
        self.latest_snapshot: Optional[dict] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._lock = threading.RLock()

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._loop = loop
            self._stop_event.clear()
            self._thread = threading.Thread(target=self._run, daemon=True, name="starlink-worker")
            self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)
        self.collector.close()

    def get_snapshot(self) -> Optional[dict]:
        with self._lock:
            return self.latest_snapshot

    def _run(self) -> None:
        while not self._stop_event.is_set():
            loop_started = time.time()
            batch = self.collector.poll(datetime.now(timezone.utc))

            with self._lock:
                if batch.status:
                    self.status = batch.status
                if batch.alerts:
                    self.alerts = batch.alerts
                self.last_error = batch.error

                for sample in batch.samples:
                    self.samples.append(sample)
                    self.autorate.update(sample.latency_ms, sample.drop_rate)

                snapshot = self._build_snapshot()
                self.latest_snapshot = snapshot

            if self._loop is not None:
                asyncio.run_coroutine_threadsafe(self.hub.broadcast(snapshot), self._loop)

            elapsed = time.time() - loop_started
            time.sleep(max(0.05, self.settings.poll_interval_s - elapsed))

    def _build_snapshot(self) -> dict:
        sample_list = list(self.samples)
        throughput = compute_optimal_throughput(
            sample_list,
            window_seconds=self.settings.throughput_window_seconds,
        )
        throughput["autorate"] = self.autorate.snapshot()

        latest = sample_list[-1] if sample_list else None
        sky_snapshot = self.sky_monitor.state_snapshot() if self.sky_monitor else {}
        return {
            "type": "telemetry",
            "generated_at": isoformat_z(datetime.now(timezone.utc)),
            "status": {
                "state": self.status.get("state", "UNKNOWN"),
                "uptime_s": self.status.get("uptime"),
                "latency_ms": latest.latency_ms if latest else self.status.get("pop_ping_latency_ms"),
                "drop_rate": latest.drop_rate if latest else self.status.get("pop_ping_drop_rate"),
                "downlink_bps": latest.downlink_bps if latest else self.status.get("downlink_throughput_bps", 0.0),
                "uplink_bps": latest.uplink_bps if latest else self.status.get("uplink_throughput_bps", 0.0),
                "device_id": self.status.get("id"),
                "software_version": self.status.get("software_version"),
            },
            "timeline": build_outage_timeline(
                sample_list,
                window_seconds=self.settings.timeline_window_seconds,
            ),
            "throughput": throughput,
            "bufferbloat": build_bufferbloat_curve(
                sample_list,
                window_seconds=self.settings.bufferbloat_window_seconds,
                bucket_count=self.settings.bufferbloat_bucket_count,
            ),
            "alerts": self.alerts,
            "sky": sky_snapshot,
            "meta": {
                "sample_count": len(sample_list),
                "worker_error": self.last_error,
            },
        }
