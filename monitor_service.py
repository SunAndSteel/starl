from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import logging
import os
from pathlib import Path
import threading
import time
from typing import Optional, Sequence

import starlink_grpc

from obstruction_analysis import detect_persistent_obstructions, infer_projection
from png_export import render_export_png
from satellite_tracking import ObserverLocation, PassiveTracker, TleTracker
from storage import PersistentStore


DEFAULT_TLE_SOURCE = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle"
logger = logging.getLogger("starl.sky.monitor")


def _env_float(name: str) -> Optional[float]:
    value = os.getenv(name)
    if value in (None, ""):
        return None
    return float(value)


def _env_flag(name: str) -> bool:
    value = os.getenv(name, "")
    return value.strip().lower() not in {"", "0", "false", "no", "off"}


@dataclass
class MonitorConfig:
    poll_interval_s: float = float(os.getenv("STARLINK_POLL_INTERVAL", "1.0"))
    save_interval_s: float = float(os.getenv("STARLINK_SAVE_INTERVAL", "30.0"))
    location_refresh_s: float = float(os.getenv("STARLINK_LOCATION_REFRESH", "60.0"))
    tle_refresh_s: float = float(os.getenv("STARLINK_TLE_REFRESH", "3600.0"))
    tle_compute_interval_s: float = float(os.getenv("STARLINK_TLE_COMPUTE_INTERVAL", "1.0"))
    history_parse_samples: int = int(os.getenv("STARLINK_HISTORY_PARSE_SAMPLES", "8"))
    state_path: str = os.getenv(
        "STARLINK_STATE_PATH",
        str(Path(__file__).resolve().parent / "data" / "monitor_state.json"),
    )
    tle_source: str = os.getenv("STARLINK_TLE_SOURCE", DEFAULT_TLE_SOURCE)
    observer_latitude: Optional[float] = _env_float("STARLINK_OBSERVER_LAT")
    observer_longitude: Optional[float] = _env_float("STARLINK_OBSERVER_LON")
    observer_altitude_m: float = float(os.getenv("STARLINK_OBSERVER_ALT_M", "0.0"))


class MonitorService:
    def __init__(self, config: Optional[MonitorConfig] = None) -> None:
        self.config = config or MonitorConfig()
        self.ctx = starlink_grpc.ChannelContext()
        self.store = PersistentStore(self.config.state_path)
        self.tle_tracker = TleTracker(self.config.tle_source)
        self.lock = threading.RLock()
        self.debug_enabled = _env_flag("STARLINK_DEBUG_SKY")
        self.started = False
        self.start_lock = threading.Lock()
        self.started_at = datetime.now(timezone.utc)
        self.last_error: Optional[str] = None
        self.last_history_counter: Optional[int] = None
        self.last_location_refresh = 0.0
        self.last_live_sat_compute = 0.0
        self.dirty = False
        self._stop_event = threading.Event()
        self._threads: list[threading.Thread] = []

        self.current_map: Optional[list[list[float]]] = None
        self.accum_map: Optional[list[list[float]]] = None
        self.count_map: Optional[list[list[int]]] = None
        self.average_map: Optional[list[list[float]]] = None
        self.obstruction_mask: Optional[list[list[int]]] = None
        self.obstruction_clusters: list[dict] = []
        self.obstruction_stats: dict = {}
        self.map_projection: dict = {}
        self.status: dict = {}
        self.alerts: dict = {}
        self.observer: Optional[ObserverLocation] = self._default_observer()
        self.observer_source: Optional[str] = "config" if self.observer else None
        self.live_satellites: list[dict] = []
        self.satellite_segments: list[dict] = []
        self.live_satellites_generated_at: Optional[float] = None
        self.passive_tracker: Optional[PassiveTracker] = None

        self._restore_state()

    def start(self) -> None:
        with self.start_lock:
            if self.started:
                return
            self.started = True
            self._stop_event.clear()
            self._threads = [
                threading.Thread(target=self._collector_loop, daemon=True, name="starlink-collector"),
                threading.Thread(target=self._persistence_loop, daemon=True, name="starlink-persistence"),
                threading.Thread(target=self._tle_refresh_loop, daemon=True, name="starlink-tle-refresh"),
            ]
            for thread in self._threads:
                thread.start()

    def stop(self) -> None:
        with self.start_lock:
            if not self.started:
                return
            self.started = False
            self._stop_event.set()
            self._save_state()
            for thread in self._threads:
                thread.join(timeout=2.0)
            self._threads = []

    def state_snapshot(self) -> dict:
        with self.lock:
            dimensions = self._dimensions()
            current = self._clone_matrix(self.current_map)
            average = self._clone_matrix(self.average_map)
            mask = self._clone_matrix(self.obstruction_mask)
            track_map = self.passive_tracker.normalized_map() if self.passive_tracker else []
            live_satellites = [dict(item) for item in self.live_satellites]
            satellite_segments = [
                {
                    **dict(segment),
                    "track": [list(point) for point in segment.get("track", [])],
                    "quality_track": [list(point) for point in segment.get("quality_track", [])],
                    "beam_quality_track": [list(point) for point in segment.get("beam_quality_track", [])],
                }
                for segment in self.satellite_segments
            ]
            azimuth = self.status.get("direction_azimuth")
            if azimuth is not None:
                azimuth = float(azimuth) % 360.0
            observer = (
                {
                    "latitude": self.observer.latitude,
                    "longitude": self.observer.longitude,
                    "altitude_m": self.observer.altitude_m,
                    "source": self.observer_source,
                }
                if self.observer
                else None
            )

            return {
                "ready": bool(current or average),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "dimensions": dimensions,
                "projection": dict(self.map_projection),
                "layers": {
                    "current": current,
                    "average": average,
                    "persistent_mask": mask,
                    "satellite_tracks": track_map,
                },
                "dish": {
                    "azimuth": azimuth,
                    "elevation": self.status.get("direction_elevation"),
                    "fov_half_angle_deg": self.tle_tracker.fov_half_angle_deg,
                    "fov_total_angle_deg": self.tle_tracker.fov_half_angle_deg * 2.0,
                },
                "metrics": {
                    "latency_ms": self.status.get("pop_ping_latency_ms"),
                    "packet_loss": self.status.get("pop_ping_drop_rate"),
                    "downlink_bps": self.status.get("downlink_throughput_bps"),
                    "uplink_bps": self.status.get("uplink_throughput_bps"),
                    "fraction_obstructed": self.status.get("fraction_obstructed"),
                    "state": self.status.get("state"),
                },
                "observer": observer,
                "persistent_obstructions": {
                    "mask": mask,
                    "clusters": [dict(cluster) for cluster in self.obstruction_clusters],
                    "stats": dict(self.obstruction_stats),
                },
                "passive_tracking": {
                    "track_map": track_map,
                    "total_events": self.passive_tracker.total_events if self.passive_tracker else 0,
                    "last_event_at": self.passive_tracker.last_event_at if self.passive_tracker else None,
                    "thresholds": self.passive_tracker.thresholds() if self.passive_tracker else {},
                },
                "tle": {
                    **self.tle_tracker.status(),
                    "visible_count": len(live_satellites),
                    "active_segment_count": len(satellite_segments),
                },
                "generated_at": self.live_satellites_generated_at,
                "live_satellites": live_satellites,
                "satellite_segments": satellite_segments,
                "alerts": dict(self.alerts),
                "errors": {"collector": self.last_error},
            }

    def export_png(self, layer_name: str = "average", size: int = 1024) -> bytes:
        with self.lock:
            return render_export_png(
                layer_name=layer_name,
                current_map=self.current_map,
                average_map=self.average_map,
                obstruction_mask=self.obstruction_mask,
                track_map=self.passive_tracker.normalized_map() if self.passive_tracker else None,
                map_projection=self.map_projection,
                dish={
                    "azimuth": None if self.status.get("direction_azimuth") is None else float(self.status.get("direction_azimuth")) % 360.0,
                    "elevation": self.status.get("direction_elevation"),
                },
                clusters=self.obstruction_clusters,
                live_satellites=self.live_satellites,
                size=size,
            )

    def reset(self) -> dict:
        starlink_grpc.reset_obstruction_map(context=self.ctx)
        with self.lock:
            self.current_map = None
            self.accum_map = None
            self.count_map = None
            self.average_map = None
            self.obstruction_mask = None
            self.obstruction_clusters = []
            self.obstruction_stats = {}
            self.map_projection = {}
            self.live_satellites = []
            self.satellite_segments = []
            self.live_satellites_generated_at = None
            self.passive_tracker = None
            self.last_history_counter = None
            self.dirty = True
        if self.debug_enabled:
            logger.info("Sky monitor reset obstruction history and live satellite caches")
        self._save_state()
        return {"ok": True}

    def set_observer(self, latitude: float, longitude: float, altitude_m: float = 0.0) -> dict:
        with self.lock:
            self.observer = ObserverLocation(latitude=float(latitude), longitude=float(longitude), altitude_m=float(altitude_m))
            self.observer_source = "manual"
            self.dirty = True
        logger.info(
            "Observer updated source=manual latitude=%.6f longitude=%.6f altitude_m=%.2f",
            float(latitude),
            float(longitude),
            float(altitude_m),
        )
        self._save_state()
        return {
            "ok": True,
            "observer": {
                "latitude": self.observer.latitude,
                "longitude": self.observer.longitude,
                "altitude_m": self.observer.altitude_m,
                "source": self.observer_source,
            },
        }

    def refresh_tle(self) -> dict:
        status = self.tle_tracker.refresh()
        if self.debug_enabled:
            logger.info(
                "Requested TLE refresh available=%s satellite_count=%s error=%s",
                status.get("available"),
                status.get("satellite_count"),
                status.get("error"),
            )
        return status

    def _collector_loop(self) -> None:
        while not self._stop_event.is_set():
            loop_started = time.time()
            now = datetime.now(timezone.utc)
            errors: list[str] = []
            grid = None
            grid_projection = None
            status = None
            alerts = None
            bulk_general = None
            bulk_samples = None
            location = None

            try:
                raw_map = starlink_grpc.get_obstruction_map(context=self.ctx)
                cols = int(raw_map.num_cols)
                rows = int(raw_map.num_rows)
                grid = tuple(tuple(raw_map.snr[i:i + cols]) for i in range(0, cols * rows, cols))
                reference_frame = getattr(raw_map, "map_reference_frame", None)
                grid_projection = infer_projection(
                    grid,
                    min_elevation_deg=float(getattr(raw_map, "min_elevation_deg", 0.0) or 0.0),
                    max_theta_deg=getattr(raw_map, "max_theta_deg", None),
                    reference_frame=str(reference_frame) if reference_frame is not None else "FRAME_EARTH",
                )
            except Exception as exc:
                errors.append(f"obstruction_map: {exc}")

            try:
                status, _, alerts = starlink_grpc.status_data(context=self.ctx)
            except Exception as exc:
                errors.append(f"status_data: {exc}")

            try:
                bulk_general, bulk_samples = starlink_grpc.history_bulk_data(
                    parse_samples=self.config.history_parse_samples,
                    start=self.last_history_counter,
                    context=self.ctx,
                )
            except Exception as exc:
                errors.append(f"history_bulk_data: {exc}")

            if (loop_started - self.last_location_refresh) >= self.config.location_refresh_s:
                try:
                    location = starlink_grpc.location_data(context=self.ctx)
                    self.last_location_refresh = loop_started
                except Exception as exc:
                    errors.append(f"location_data: {exc}")

            with self.lock:
                if grid is not None:
                    self._apply_grid(grid, grid_projection)
                if status is not None:
                    self.status = status
                if alerts is not None:
                    self.alerts = alerts
                if location is not None:
                    self.observer, self.observer_source = self._resolve_observer(location)
                if bulk_general and bulk_samples:
                    self.last_history_counter = bulk_general.get("end_counter")
                    self._apply_history_samples(
                        bulk_general,
                        bulk_samples,
                        status or self.status,
                        now,
                    )
                self.last_error = " | ".join(errors) if errors else None

            should_compute_live = (loop_started - self.last_live_sat_compute) >= self.config.tle_compute_interval_s
            observer = None
            dish_azimuth = None
            dish_elevation = None
            with self.lock:
                observer = self.observer
                dish_azimuth = self.status.get("direction_azimuth") if self.status else None
                dish_elevation = self.status.get("direction_elevation") if self.status else None

            if should_compute_live:
                satellite_state = self.tle_tracker.tracked_satellites(
                    observer,
                    direction_azimuth=dish_azimuth,
                    direction_elevation=dish_elevation,
                    when=now,
                )
                with self.lock:
                    self.live_satellites = satellite_state["live_satellites"]
                    self.satellite_segments = satellite_state["satellite_segments"]
                    self.live_satellites_generated_at = satellite_state["generated_at"]
                    self.last_live_sat_compute = loop_started
                if self.debug_enabled:
                    logger.info(
                        "Monitor live-sat update generated_at=%.3f observer=%s dish=(%s,%s) live=%d segments=%d",
                        float(satellite_state["generated_at"]),
                        self.observer_source or "unknown",
                        "n/a" if dish_azimuth is None else f"{float(dish_azimuth) % 360.0:.1f}",
                        "n/a" if dish_elevation is None else f"{float(dish_elevation):.1f}",
                        len(satellite_state["live_satellites"]),
                        len(satellite_state["satellite_segments"]),
                    )

            elapsed = time.time() - loop_started
            self._stop_event.wait(max(0.05, self.config.poll_interval_s - elapsed))

    def _persistence_loop(self) -> None:
        while not self._stop_event.wait(self.config.save_interval_s):
            self._save_state()

    def _tle_refresh_loop(self) -> None:
        while not self._stop_event.is_set():
            self.tle_tracker.refresh()
            if self._stop_event.wait(self.config.tle_refresh_s):
                break

    def _apply_grid(self, grid: Sequence[Sequence[float]], projection: Optional[dict]) -> None:
        height = len(grid)
        width = len(grid[0]) if height else 0
        if not height or not width:
            return

        self.map_projection = dict(projection or infer_projection(grid))

        if (
            self.accum_map is None
            or self.count_map is None
            or len(self.accum_map) != height
            or len(self.accum_map[0]) != width
        ):
            self.accum_map = [[0.0] * width for _ in range(height)]
            self.count_map = [[0] * width for _ in range(height)]
            initial_track = None
            if self.passive_tracker and self.passive_tracker.width == width and self.passive_tracker.height == height:
                initial_track = self.passive_tracker.track_map
            self.passive_tracker = PassiveTracker(width, height, projection=self.map_projection, initial_track_map=initial_track)
        elif self.passive_tracker is not None:
            self.passive_tracker.set_projection(self.map_projection)

        self.current_map = [list(row) for row in grid]
        for y in range(height):
            for x in range(width):
                value = grid[y][x]
                if value is None or value < 0:
                    continue
                self.accum_map[y][x] += float(value)
                self.count_map[y][x] += 1

        analysis = detect_persistent_obstructions(self.accum_map, self.count_map, map_projection=self.map_projection)
        self.average_map = analysis["average_map"]
        self.obstruction_mask = analysis["mask"]
        self.obstruction_clusters = analysis["clusters"]
        self.obstruction_stats = analysis["stats"]
        self.dirty = True

    def _apply_history_samples(self, general: dict, bulk: dict, status: dict, now: datetime) -> None:
        if not self.passive_tracker:
            return

        samples = int(general.get("samples", 0))
        if samples <= 0:
            return

        azimuth = status.get("direction_azimuth") if status else None
        elevation = status.get("direction_elevation") if status else None
        latencies = bulk.get("pop_ping_latency_ms", [])
        drops = bulk.get("pop_ping_drop_rate", [])
        downs = bulk.get("downlink_throughput_bps", [])
        ups = bulk.get("uplink_throughput_bps", [])

        for index in range(samples):
            sample_time = now - timedelta(seconds=(samples - index - 1))
            self.passive_tracker.process_sample(
                latency_ms=latencies[index] if index < len(latencies) else None,
                packet_loss=drops[index] if index < len(drops) else None,
                downlink_bps=downs[index] if index < len(downs) else None,
                uplink_bps=ups[index] if index < len(ups) else None,
                azimuth=azimuth,
                elevation=elevation,
                timestamp=sample_time,
            )
        self.dirty = True

    def _restore_state(self) -> None:
        payload = self.store.load()
        accum_map = payload.get("accum_map")
        count_map = payload.get("count_map")
        passive_track_map = payload.get("passive_track_map")
        self.map_projection = dict(payload.get("map_projection") or {})

        saved_observer = payload.get("observer")
        if saved_observer and self.observer is None:
            try:
                self.observer = ObserverLocation(
                    latitude=float(saved_observer["latitude"]),
                    longitude=float(saved_observer["longitude"]),
                    altitude_m=float(saved_observer.get("altitude_m", 0.0)),
                )
                self.observer_source = str(saved_observer.get("source", "persisted"))
            except (KeyError, TypeError, ValueError):
                self.observer = self._default_observer()
                self.observer_source = "config" if self.observer else None

        if accum_map and count_map:
            self.accum_map = [[float(value) for value in row] for row in accum_map]
            self.count_map = [[int(value) for value in row] for row in count_map]
            analysis = detect_persistent_obstructions(self.accum_map, self.count_map, map_projection=self.map_projection)
            self.average_map = analysis["average_map"]
            self.obstruction_mask = analysis["mask"]
            self.obstruction_clusters = analysis["clusters"]
            self.obstruction_stats = analysis["stats"]
            height = len(self.accum_map)
            width = len(self.accum_map[0]) if height else 0
            if height and width:
                self.passive_tracker = PassiveTracker(
                    width,
                    height,
                    projection=self.map_projection,
                    initial_track_map=passive_track_map,
                    total_events=int(payload.get("passive_total_events", 0)),
                    last_event_at=payload.get("passive_last_event_at"),
                )

    def _save_state(self) -> None:
        with self.lock:
            if not self.dirty:
                return
            payload = {
                "saved_at": datetime.now(timezone.utc).isoformat(),
                "accum_map": self.accum_map,
                "count_map": self.count_map,
                "map_projection": self.map_projection,
                "observer": (
                    {
                        "latitude": self.observer.latitude,
                        "longitude": self.observer.longitude,
                        "altitude_m": self.observer.altitude_m,
                        "source": self.observer_source,
                    }
                    if self.observer
                    else None
                ),
                "passive_track_map": self.passive_tracker.track_map if self.passive_tracker else None,
                "passive_total_events": self.passive_tracker.total_events if self.passive_tracker else 0,
                "passive_last_event_at": self.passive_tracker.last_event_at if self.passive_tracker else None,
            }
            self.dirty = False
        self.store.save(payload)

    def _default_observer(self) -> Optional[ObserverLocation]:
        if self.config.observer_latitude is None or self.config.observer_longitude is None:
            return None
        return ObserverLocation(
            latitude=self.config.observer_latitude,
            longitude=self.config.observer_longitude,
            altitude_m=self.config.observer_altitude_m,
        )

    def _resolve_observer(self, location: Optional[dict]) -> tuple[Optional[ObserverLocation], Optional[str]]:
        latitude = location.get("latitude") if location else None
        longitude = location.get("longitude") if location else None
        altitude = location.get("altitude") if location else None

        if latitude is not None and longitude is not None:
            return ObserverLocation(
                latitude=float(latitude),
                longitude=float(longitude),
                altitude_m=float(altitude or 0.0),
            ), "gps"

        if self.observer is not None:
            return self.observer, self.observer_source

        fallback = self._default_observer()
        return fallback, ("config" if fallback else None)

    def _dimensions(self) -> dict:
        if self.average_map:
            return {"width": len(self.average_map[0]), "height": len(self.average_map)}
        if self.current_map:
            return {"width": len(self.current_map[0]), "height": len(self.current_map)}
        return {"width": 0, "height": 0}

    def _clone_matrix(self, grid: Optional[Sequence[Sequence[float]]]) -> list[list[float]]:
        if not grid:
            return []
        return [list(row) for row in grid]
