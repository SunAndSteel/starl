from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import logging
import math
import os
import threading
from typing import Deque, List, Optional, Sequence, Tuple
from urllib.request import Request, urlopen
from uuid import uuid4

from sgp4.api import Satrec, jday

from obstruction_analysis import grid_to_sky, sky_to_grid


EARTH_RADIUS_KM = 6378.137
EARTH_FLATTENING = 1.0 / 298.257223563
EARTH_E2 = EARTH_FLATTENING * (2.0 - EARTH_FLATTENING)
DEFAULT_DISH_FOV_HALF_ANGLE_DEG = 55.0
DEFAULT_PROPAGATION_STEP_S = 1.0
DEFAULT_SEGMENT_HORIZON_S = 600.0
BOUNDARY_REFINEMENT_ITERATIONS = 12
DEBUG_SUMMARY_INTERVAL_S = 5.0
SGP4_ERROR_LOG_INTERVAL_S = 60.0
logger = logging.getLogger("starl.sky.tracker")


def _env_flag(name: str) -> bool:
    value = os.getenv(name, "")
    return value.strip().lower() not in {"", "0", "false", "no", "off"}


def percentile(values: Sequence[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = max(0.0, min(1.0, p)) * (len(ordered) - 1)
    lo = int(math.floor(rank))
    hi = int(math.ceil(rank))
    if lo == hi:
        return ordered[lo]
    fraction = rank - lo
    return ordered[lo] * (1.0 - fraction) + ordered[hi] * fraction


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def normalize_vector(vector: Tuple[float, float, float]) -> Tuple[float, float, float]:
    x, y, z = vector
    length = math.sqrt(x * x + y * y + z * z)
    if length <= 0.0:
        return 0.0, 0.0, 1.0
    return x / length, y / length, z / length


def dot_product(a: Tuple[float, float, float], b: Tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def azel_to_xyz(azimuth_deg: float, elevation_deg: float) -> Tuple[float, float, float]:
    azimuth = math.radians(azimuth_deg)
    elevation = math.radians(elevation_deg)
    return normalize_vector(
        (
            math.cos(elevation) * math.sin(azimuth),
            math.sin(elevation),
            math.cos(elevation) * math.cos(azimuth),
        )
    )


def angular_distance_deg(azimuth_a: float, elevation_a: float, azimuth_b: float, elevation_b: float) -> float:
    vec_a = azel_to_xyz(azimuth_a, elevation_a)
    vec_b = azel_to_xyz(azimuth_b, elevation_b)
    dot = clamp(dot_product(vec_a, vec_b), -1.0, 1.0)
    return math.degrees(math.acos(dot))


def shortest_angular_delta_deg(start_deg: float, end_deg: float) -> float:
    delta = (end_deg - start_deg + 180.0) % 360.0 - 180.0
    return 180.0 if delta == -180.0 else delta


@dataclass
class ObserverLocation:
    latitude: float
    longitude: float
    altitude_m: float = 0.0


@dataclass
class TleSatellite:
    name: str
    norad_id: str
    epoch: datetime
    inclination_deg: float
    raan_deg: float
    eccentricity: float
    arg_perigee_deg: float
    mean_anomaly_deg: float
    mean_motion_rev_per_day: float
    line1: str
    line2: str
    satrec: Satrec = field(repr=False, compare=False)


class PassiveTracker:
    def __init__(
        self,
        width: int,
        height: int,
        projection: Optional[dict] = None,
        initial_track_map: Optional[Sequence[Sequence[float]]] = None,
        total_events: int = 0,
        last_event_at: Optional[str] = None,
    ) -> None:
        self.width = width
        self.height = height
        self.projection = dict(projection or {})
        self.track_map = self._normalize_shape(initial_track_map) if initial_track_map else [
            [0.0] * width for _ in range(height)
        ]
        self.total_events = total_events
        self.last_event_at = last_event_at
        self.latency_history: Deque[float] = deque(maxlen=180)
        self.drop_history: Deque[float] = deque(maxlen=180)
        self.throughput_history: Deque[float] = deque(maxlen=180)
        self.last_good_point: Optional[Tuple[int, int, float, float, datetime]] = None
        self.last_thresholds = {
            "latency_ms": 60.0,
            "packet_loss": 0.02,
            "throughput_bps": 15_000_000.0,
        }

    def _normalize_shape(self, track_map: Sequence[Sequence[float]]) -> List[List[float]]:
        normalized = [[0.0] * self.width for _ in range(self.height)]
        for y in range(min(self.height, len(track_map))):
            row = track_map[y]
            for x in range(min(self.width, len(row))):
                normalized[y][x] = float(row[x])
        return normalized

    def reset(self) -> None:
        self.track_map = [[0.0] * self.width for _ in range(self.height)]
        self.total_events = 0
        self.last_event_at = None
        self.last_good_point = None
        self.latency_history.clear()
        self.drop_history.clear()
        self.throughput_history.clear()

    def set_projection(self, projection: Optional[dict]) -> None:
        self.projection = dict(projection or {})

    def normalized_map(self) -> List[List[float]]:
        peak = max((max(row) for row in self.track_map), default=0.0)
        if peak <= 0:
            return [[0.0] * self.width for _ in range(self.height)]
        return [[round(value / peak, 4) for value in row] for row in self.track_map]

    def thresholds(self) -> dict:
        return dict(self.last_thresholds)

    def process_sample(
        self,
        latency_ms: Optional[float],
        packet_loss: Optional[float],
        downlink_bps: Optional[float],
        uplink_bps: Optional[float],
        azimuth: Optional[float],
        elevation: Optional[float],
        timestamp: datetime,
    ) -> bool:
        if latency_ms is not None:
            self.latency_history.append(float(latency_ms))
        if packet_loss is not None:
            self.drop_history.append(max(0.0, float(packet_loss)))

        throughput_bps = float(max((downlink_bps or 0.0) + (uplink_bps or 0.0), downlink_bps or 0.0))
        if throughput_bps > 0:
            self.throughput_history.append(throughput_bps)

        latency_limit = 60.0
        if len(self.latency_history) >= 20:
            latency_limit = min(percentile(self.latency_history, 0.35) + 8.0, 60.0)

        packet_loss_limit = 0.02
        if len(self.drop_history) >= 20:
            packet_loss_limit = min(percentile(self.drop_history, 0.5) + 0.005, 0.03)

        throughput_limit = 15_000_000.0
        if len(self.throughput_history) >= 20:
            throughput_limit = max(percentile(self.throughput_history, 0.7), 15_000_000.0)

        self.last_thresholds = {
            "latency_ms": round(latency_limit, 2),
            "packet_loss": round(packet_loss_limit, 4),
            "throughput_bps": round(throughput_limit, 2),
        }

        good_event = (
            latency_ms is not None
            and packet_loss is not None
            and latency_ms <= latency_limit
            and packet_loss <= packet_loss_limit
            and throughput_bps >= throughput_limit
            and azimuth is not None
            and elevation is not None
            and elevation > 5.0
        )

        if not good_event:
            return False

        normalized_azimuth = float(azimuth) % 360.0
        x, y = sky_to_grid(normalized_azimuth, float(elevation), self.width, self.height, self.projection)
        self._stamp(x, y, value=1.0, radius=1)

        if self.last_good_point is not None:
            last_x, last_y, last_az, last_el, last_ts = self.last_good_point
            seconds_apart = abs((timestamp - last_ts).total_seconds())
            movement = angular_distance_deg(last_az, last_el, normalized_azimuth, float(elevation))
            if seconds_apart <= 20.0 and movement <= 35.0:
                self._draw_line(last_x, last_y, x, y, value=0.65)

        self.total_events += 1
        self.last_event_at = timestamp.isoformat()
        self.last_good_point = (x, y, normalized_azimuth, float(elevation), timestamp)
        return True

    def _stamp(self, x: int, y: int, value: float, radius: int) -> None:
        for ny in range(max(0, y - radius), min(self.height, y + radius + 1)):
            for nx in range(max(0, x - radius), min(self.width, x + radius + 1)):
                distance = abs(nx - x) + abs(ny - y)
                attenuation = max(0.25, 1.0 - 0.25 * distance)
                self.track_map[ny][nx] += value * attenuation

    def _draw_line(self, x0: int, y0: int, x1: int, y1: int, value: float) -> None:
        dx = abs(x1 - x0)
        dy = -abs(y1 - y0)
        step_x = 1 if x0 < x1 else -1
        step_y = 1 if y0 < y1 else -1
        error = dx + dy
        x = x0
        y = y0

        while True:
            self._stamp(x, y, value=value, radius=1)
            if x == x1 and y == y1:
                break
            error2 = 2 * error
            if error2 >= dy:
                error += dy
                x += step_x
            if error2 <= dx:
                error += dx
                y += step_y


@dataclass
class SatelliteSample:
    timestamp: float
    azimuth: float
    elevation: float
    range_km: float
    vector: Tuple[float, float, float]
    raw_alignment: float
    quality: float
    beam_quality: float
    inside_fov: bool


class TleTracker:
    def __init__(
        self,
        source: str,
        timeout_s: float = 10.0,
        *,
        fov_half_angle_deg: float = DEFAULT_DISH_FOV_HALF_ANGLE_DEG,
        propagation_step_s: float = DEFAULT_PROPAGATION_STEP_S,
        segment_horizon_s: float = DEFAULT_SEGMENT_HORIZON_S,
    ) -> None:
        self.source = source
        self.timeout_s = timeout_s
        self.fov_half_angle_deg = float(fov_half_angle_deg)
        self.propagation_step_s = clamp(float(propagation_step_s), 0.25, 2.0)
        self.segment_horizon_s = max(float(segment_horizon_s), self.propagation_step_s * 2.0)
        self.cos_threshold = math.cos(math.radians(self.fov_half_angle_deg))
        self.debug_enabled = _env_flag("STARLINK_DEBUG_SKY")
        self._lock = threading.RLock()
        self._satellites: List[TleSatellite] = []
        self._active_segment_ids: dict[str, str] = {}
        self._last_missing_signature: Optional[str] = None
        self._last_summary_log_at = 0.0
        self._last_sgp4_error_logged_at: dict[str, float] = {}
        self.last_updated_at: Optional[str] = None
        self.last_error: Optional[str] = None

    def refresh(self) -> dict:
        try:
            text = self._read_source(self.source)
            satellites = self._parse_catalog(text)
            with self._lock:
                self._satellites = satellites
                self.last_updated_at = datetime.now(timezone.utc).isoformat()
                self.last_error = None
            if self.debug_enabled:
                logger.info(
                    "TLE refresh complete source=%s satellites=%d fov_half_angle_deg=%.1f step_s=%.1f horizon_s=%.1f",
                    self.source,
                    len(satellites),
                    self.fov_half_angle_deg,
                    self.propagation_step_s,
                    self.segment_horizon_s,
                )
            return self.status()
        except Exception as exc:
            with self._lock:
                self.last_error = str(exc)
            logger.warning("TLE refresh failed source=%s error=%s", self.source, exc)
            return self.status()

    def status(self) -> dict:
        with self._lock:
            return {
                "source": self.source,
                "available": bool(self._satellites),
                "satellite_count": len(self._satellites),
                "updated_at": self.last_updated_at,
                "fov_half_angle_deg": self.fov_half_angle_deg,
                "propagation_step_s": self.propagation_step_s,
                "error": self.last_error,
            }

    def tracked_satellites(
        self,
        observer: Optional[ObserverLocation],
        direction_azimuth: Optional[float],
        direction_elevation: Optional[float],
        when: Optional[datetime] = None,
        max_results: int = 64,
    ) -> dict:
        now = (when or datetime.now(timezone.utc)).astimezone(timezone.utc)
        generated_at = now.timestamp()

        if (
            observer is None
            or direction_azimuth is None
            or direction_elevation is None
        ):
            with self._lock:
                self._active_segment_ids = {}
            self._log_missing_state(
                observer=observer,
                direction_azimuth=direction_azimuth,
                direction_elevation=direction_elevation,
                catalog_size=None,
            )
            return {
                "generated_at": generated_at,
                "live_satellites": [],
                "satellite_segments": [],
            }

        with self._lock:
            satellites = list(self._satellites)
            previous_segment_ids = dict(self._active_segment_ids)

        if not satellites:
            with self._lock:
                self._active_segment_ids = {}
            self._log_missing_state(
                observer=observer,
                direction_azimuth=direction_azimuth,
                direction_elevation=direction_elevation,
                catalog_size=0,
            )
            return {
                "generated_at": generated_at,
                "live_satellites": [],
                "satellite_segments": [],
            }

        observer_ecef = _geodetic_to_ecef(observer)
        dish_vec = azel_to_xyz(float(direction_azimuth) % 360.0, float(direction_elevation))
        candidates: list[tuple[float, float, TleSatellite, SatelliteSample, dict[float, Optional[SatelliteSample]]]] = []

        for satellite in satellites:
            sample_cache: dict[float, Optional[SatelliteSample]] = {}
            current_sample = self._sample_satellite(
                satellite,
                generated_at,
                observer,
                observer_ecef,
                dish_vec,
                sample_cache,
            )
            if current_sample is None or not current_sample.inside_fov:
                continue
            candidates.append(
                (
                    current_sample.beam_quality,
                    current_sample.elevation,
                    satellite,
                    current_sample,
                    sample_cache,
                )
            )

        candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        live_satellites: list[dict] = []
        segments: list[dict] = []
        active_segment_ids: dict[str, str] = {}

        for _, _, satellite, current_sample, sample_cache in candidates[:max_results]:
            segment_id = previous_segment_ids.get(satellite.norad_id, str(uuid4()))
            segment = self._build_segment(
                satellite=satellite,
                segment_id=segment_id,
                now_ts=generated_at,
                observer=observer,
                observer_ecef=observer_ecef,
                dish_vec=dish_vec,
                current_sample=current_sample,
                sample_cache=sample_cache,
            )
            if segment is None:
                continue

            segments.append(segment)
            active_segment_ids[satellite.norad_id] = segment_id
            live_satellites.append(
                {
                    "name": satellite.name,
                    "sat_id": satellite.norad_id,
                    "segment_id": segment_id,
                    "tracked_at": round(generated_at, 6),
                    "generated_at": round(generated_at, 6),
                    "azimuth": round(current_sample.azimuth, 6),
                    "elevation": round(current_sample.elevation, 6),
                    "range_km": round(current_sample.range_km, 3),
                    "quality": round(current_sample.quality, 6),
                    "beam_quality": round(current_sample.beam_quality, 6),
                    "t_entry": segment["t_entry"],
                    "t_exit": segment["t_exit"],
                }
            )

        with self._lock:
            self._active_segment_ids = active_segment_ids
        self._last_missing_signature = None
        self._log_summary(
            generated_at=generated_at,
            observer=observer,
            direction_azimuth=float(direction_azimuth),
            direction_elevation=float(direction_elevation),
            catalog_size=len(satellites),
            candidate_count=len(candidates),
            live_satellites=live_satellites,
            segments=segments,
        )

        return {
            "generated_at": generated_at,
            "live_satellites": live_satellites,
            "satellite_segments": segments,
        }

    def _log_missing_state(
        self,
        *,
        observer: Optional[ObserverLocation],
        direction_azimuth: Optional[float],
        direction_elevation: Optional[float],
        catalog_size: Optional[int],
    ) -> None:
        if not self.debug_enabled:
            return

        signature = (
            f"observer={observer is not None};"
            f"dish={direction_azimuth is not None and direction_elevation is not None};"
            f"catalog={catalog_size}"
        )
        if signature == self._last_missing_signature:
            return

        self._last_missing_signature = signature
        logger.info(
            "Sky tracker idle observer=%s dish_direction=%s catalog_size=%s",
            "ready" if observer is not None else "missing",
            "ready" if direction_azimuth is not None and direction_elevation is not None else "missing",
            catalog_size if catalog_size is not None else "unknown",
        )

    def _log_summary(
        self,
        *,
        generated_at: float,
        observer: ObserverLocation,
        direction_azimuth: float,
        direction_elevation: float,
        catalog_size: int,
        candidate_count: int,
        live_satellites: Sequence[dict],
        segments: Sequence[dict],
    ) -> None:
        if not self.debug_enabled:
            return
        if (generated_at - self._last_summary_log_at) < DEBUG_SUMMARY_INTERVAL_S:
            return

        self._last_summary_log_at = generated_at
        top_entries = ", ".join(
            f"{entry['sat_id']}@q={entry['beam_quality']:.3f}"
            for entry in live_satellites[:5]
            if entry.get("sat_id") is not None and entry.get("beam_quality") is not None
        ) or "none"
        logger.info(
            "Sky tracker summary at=%.3f observer=(%.5f,%.5f,%.1fm) dish=(%.1f,%.1f) catalog=%d candidates=%d live=%d segments=%d top=%s",
            generated_at,
            observer.latitude,
            observer.longitude,
            observer.altitude_m,
            direction_azimuth % 360.0,
            direction_elevation,
            catalog_size,
            candidate_count,
            len(live_satellites),
            len(segments),
            top_entries,
        )

    def _read_source(self, source: str) -> str:
        if source.startswith("http://") or source.startswith("https://"):
            request = Request(source, headers={"User-Agent": "StarlinkMonitor/1.0"})
            with urlopen(request, timeout=self.timeout_s) as response:
                return response.read().decode("utf-8")

        with open(source, "r", encoding="utf-8") as handle:
            return handle.read()

    def _parse_catalog(self, text: str) -> List[TleSatellite]:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        satellites: List[TleSatellite] = []
        index = 0
        while index < len(lines):
            name = lines[index]
            if name.startswith("1 "):
                line1 = lines[index]
                line2 = lines[index + 1] if index + 1 < len(lines) else ""
                name = line1[2:7].strip()
                index += 2
            else:
                line1 = lines[index + 1] if index + 1 < len(lines) else ""
                line2 = lines[index + 2] if index + 2 < len(lines) else ""
                index += 3

            if not line1.startswith("1 ") or not line2.startswith("2 "):
                continue

            try:
                epoch = _parse_tle_epoch(line1[18:32].strip())
                parts = line2.split()
                satellites.append(
                    TleSatellite(
                        name=name.strip(),
                        norad_id=line1[2:7].strip(),
                        epoch=epoch,
                        inclination_deg=float(parts[2]),
                        raan_deg=float(parts[3]),
                        eccentricity=float(f"0.{parts[4]}"),
                        arg_perigee_deg=float(parts[5]),
                        mean_anomaly_deg=float(parts[6]),
                        mean_motion_rev_per_day=float(parts[7]),
                        line1=line1,
                        line2=line2,
                        satrec=Satrec.twoline2rv(line1, line2),
                    )
                )
            except (IndexError, ValueError):
                continue
        return satellites

    def _sample_satellite(
        self,
        satellite: TleSatellite,
        timestamp: float,
        observer: ObserverLocation,
        observer_ecef: Tuple[float, float, float],
        dish_vec: Tuple[float, float, float],
        cache: dict[float, Optional[SatelliteSample]],
    ) -> Optional[SatelliteSample]:
        cache_key = round(timestamp, 6)
        if cache_key in cache:
            return cache[cache_key]

        when = datetime.fromtimestamp(timestamp, tz=timezone.utc)
        second = when.second + when.microsecond / 1_000_000.0
        jd, fraction = jday(
            when.year,
            when.month,
            when.day,
            when.hour,
            when.minute,
            second,
        )
        error_code, position_teme_km, _ = satellite.satrec.sgp4(jd, fraction)
        if error_code != 0:
            if self.debug_enabled:
                last_logged_at = self._last_sgp4_error_logged_at.get(satellite.norad_id, 0.0)
                if (timestamp - last_logged_at) >= SGP4_ERROR_LOG_INTERVAL_S:
                    self._last_sgp4_error_logged_at[satellite.norad_id] = timestamp
                    logger.warning(
                        "SGP4 propagation failed sat_id=%s code=%s timestamp=%.3f",
                        satellite.norad_id,
                        error_code,
                        timestamp,
                    )
            cache[cache_key] = None
            return None

        gst = _greenwich_sidereal_time_rad(when)
        sat_ecef = _teme_to_ecef(position_teme_km, gst)
        azimuth, elevation, range_km = _az_el_range(sat_ecef, observer_ecef, observer)
        sat_vec = azel_to_xyz(azimuth, elevation)
        raw_alignment = clamp(dot_product(sat_vec, dish_vec), -1.0, 1.0)
        quality = clamp(raw_alignment, 0.0, 1.0)
        beam_quality = clamp(
            (raw_alignment - self.cos_threshold) / max(1.0 - self.cos_threshold, 1e-9),
            0.0,
            1.0,
        )
        sample = SatelliteSample(
            timestamp=timestamp,
            azimuth=azimuth % 360.0,
            elevation=elevation,
            range_km=range_km,
            vector=sat_vec,
            raw_alignment=raw_alignment,
            quality=quality,
            beam_quality=beam_quality,
            inside_fov=elevation > 0.0 and raw_alignment > self.cos_threshold,
        )
        cache[cache_key] = sample
        return sample

    def _refine_boundary(
        self,
        satellite: TleSatellite,
        observer: ObserverLocation,
        observer_ecef: Tuple[float, float, float],
        dish_vec: Tuple[float, float, float],
        outside_sample: SatelliteSample,
        inside_sample: SatelliteSample,
        cache: dict[float, Optional[SatelliteSample]],
    ) -> SatelliteSample:
        lo = outside_sample
        hi = inside_sample

        for _ in range(BOUNDARY_REFINEMENT_ITERATIONS):
            midpoint = (lo.timestamp + hi.timestamp) * 0.5
            sample = self._sample_satellite(
                satellite,
                midpoint,
                observer,
                observer_ecef,
                dish_vec,
                cache,
            )
            if sample is None:
                break
            if sample.inside_fov:
                hi = sample
            else:
                lo = sample

        return hi

    def _build_segment(
        self,
        *,
        satellite: TleSatellite,
        segment_id: str,
        now_ts: float,
        observer: ObserverLocation,
        observer_ecef: Tuple[float, float, float],
        dish_vec: Tuple[float, float, float],
        current_sample: SatelliteSample,
        sample_cache: dict[float, Optional[SatelliteSample]],
    ) -> Optional[dict]:
        inside_samples: list[SatelliteSample] = [current_sample]
        step_seconds = self.propagation_step_s
        horizon_seconds = self.segment_horizon_s
        previous_outside: Optional[SatelliteSample] = None
        next_outside: Optional[SatelliteSample] = None

        backward_steps = int(horizon_seconds / step_seconds)
        for index in range(1, backward_steps + 1):
            timestamp = now_ts - index * step_seconds
            sample = self._sample_satellite(
                satellite,
                timestamp,
                observer,
                observer_ecef,
                dish_vec,
                sample_cache,
            )
            if sample is None or not sample.inside_fov:
                previous_outside = sample
                break
            inside_samples.insert(0, sample)

        forward_steps = int(horizon_seconds / step_seconds)
        for index in range(1, forward_steps + 1):
            timestamp = now_ts + index * step_seconds
            sample = self._sample_satellite(
                satellite,
                timestamp,
                observer,
                observer_ecef,
                dish_vec,
                sample_cache,
            )
            if sample is None or not sample.inside_fov:
                next_outside = sample
                break
            inside_samples.append(sample)

        if previous_outside is not None:
            entry_sample = self._refine_boundary(
                satellite,
                observer,
                observer_ecef,
                dish_vec,
                previous_outside,
                inside_samples[0],
                sample_cache,
            )
            if entry_sample.timestamp < inside_samples[0].timestamp - 1e-6:
                inside_samples.insert(0, entry_sample)
        else:
            entry_sample = inside_samples[0]

        if next_outside is not None:
            exit_sample = self._refine_boundary(
                satellite,
                observer,
                observer_ecef,
                dish_vec,
                next_outside,
                inside_samples[-1],
                sample_cache,
            )
            if exit_sample.timestamp > inside_samples[-1].timestamp + 1e-6:
                inside_samples.append(exit_sample)
        else:
            exit_sample = inside_samples[-1]

        deduped_samples: list[SatelliteSample] = []
        for sample in inside_samples:
            if deduped_samples and abs(sample.timestamp - deduped_samples[-1].timestamp) <= 1e-6:
                deduped_samples[-1] = sample
            else:
                deduped_samples.append(sample)

        if len(deduped_samples) < 2:
            if self.debug_enabled:
                logger.warning("Discarded segment sat_id=%s reason=track_too_short", satellite.norad_id)
            return None
        if exit_sample.timestamp <= entry_sample.timestamp:
            if self.debug_enabled:
                logger.warning(
                    "Discarded segment sat_id=%s reason=non_positive_duration entry=%.6f exit=%.6f",
                    satellite.norad_id,
                    entry_sample.timestamp,
                    exit_sample.timestamp,
                )
            return None
        if any(not sample.inside_fov for sample in deduped_samples):
            if self.debug_enabled:
                logger.warning("Discarded segment sat_id=%s reason=track_point_outside_fov", satellite.norad_id)
            return None

        return {
            "segment_id": segment_id,
            "sat_id": satellite.norad_id,
            "name": satellite.name,
            "t_entry": round(entry_sample.timestamp, 6),
            "t_exit": round(exit_sample.timestamp, 6),
            "entry_az": round(entry_sample.azimuth, 6),
            "entry_el": round(entry_sample.elevation, 6),
            "exit_az": round(exit_sample.azimuth, 6),
            "exit_el": round(exit_sample.elevation, 6),
            "track": [
                [round(sample.timestamp, 6), round(sample.azimuth, 6), round(sample.elevation, 6)]
                for sample in deduped_samples
            ],
            "quality_track": [
                [round(sample.timestamp, 6), round(sample.quality, 6)]
                for sample in deduped_samples
            ],
            "beam_quality_track": [
                [round(sample.timestamp, 6), round(sample.beam_quality, 6)]
                for sample in deduped_samples
            ],
            "current_quality": round(current_sample.quality, 6),
            "current_beam_quality": round(current_sample.beam_quality, 6),
            "current_range_km": round(current_sample.range_km, 3),
        }


def _parse_tle_epoch(raw_epoch: str) -> datetime:
    year = int(raw_epoch[0:2])
    year += 2000 if year < 57 else 1900
    day_of_year = float(raw_epoch[2:])
    return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=day_of_year - 1.0)


def _julian_date(when: datetime) -> float:
    utc = when.astimezone(timezone.utc)
    year = utc.year
    month = utc.month
    day = utc.day + (
        utc.hour
        + (utc.minute + (utc.second + utc.microsecond / 1_000_000.0) / 60.0) / 60.0
    ) / 24.0

    if month <= 2:
        year -= 1
        month += 12

    a = year // 100
    b = 2 - a + a // 4
    return (
        math.floor(365.25 * (year + 4716))
        + math.floor(30.6001 * (month + 1))
        + day
        + b
        - 1524.5
    )


def _greenwich_sidereal_time_rad(when: datetime) -> float:
    jd = _julian_date(when)
    centuries = (jd - 2451545.0) / 36525.0
    theta_deg = (
        280.46061837
        + 360.98564736629 * (jd - 2451545.0)
        + 0.000387933 * (centuries ** 2)
        - (centuries ** 3) / 38710000.0
    )
    return math.radians(theta_deg % 360.0)


def _teme_to_ecef(position_teme: Tuple[float, float, float], gst_rad: float) -> Tuple[float, float, float]:
    x_eci, y_eci, z_eci = position_teme
    cos_gst = math.cos(gst_rad)
    sin_gst = math.sin(gst_rad)
    return (
        cos_gst * x_eci + sin_gst * y_eci,
        -sin_gst * x_eci + cos_gst * y_eci,
        z_eci,
    )


def _geodetic_to_ecef(observer: ObserverLocation) -> Tuple[float, float, float]:
    latitude = math.radians(observer.latitude)
    longitude = math.radians(observer.longitude)
    altitude_km = observer.altitude_m / 1000.0

    sin_lat = math.sin(latitude)
    cos_lat = math.cos(latitude)
    sin_lon = math.sin(longitude)
    cos_lon = math.cos(longitude)

    prime_vertical = EARTH_RADIUS_KM / math.sqrt(1.0 - EARTH_E2 * sin_lat * sin_lat)

    x = (prime_vertical + altitude_km) * cos_lat * cos_lon
    y = (prime_vertical + altitude_km) * cos_lat * sin_lon
    z = (prime_vertical * (1.0 - EARTH_E2) + altitude_km) * sin_lat
    return x, y, z


def _az_el_range(
    sat_ecef: Tuple[float, float, float],
    observer_ecef: Tuple[float, float, float],
    observer: ObserverLocation,
) -> Tuple[float, float, float]:
    dx = sat_ecef[0] - observer_ecef[0]
    dy = sat_ecef[1] - observer_ecef[1]
    dz = sat_ecef[2] - observer_ecef[2]

    latitude = math.radians(observer.latitude)
    longitude = math.radians(observer.longitude)

    sin_lat = math.sin(latitude)
    cos_lat = math.cos(latitude)
    sin_lon = math.sin(longitude)
    cos_lon = math.cos(longitude)

    east = -sin_lon * dx + cos_lon * dy
    north = -sin_lat * cos_lon * dx - sin_lat * sin_lon * dy + cos_lat * dz
    up = cos_lat * cos_lon * dx + cos_lat * sin_lon * dy + sin_lat * dz

    horizontal = math.hypot(east, north)
    azimuth = math.degrees(math.atan2(east, north)) % 360.0
    elevation = math.degrees(math.atan2(up, horizontal))
    range_km = math.sqrt(dx * dx + dy * dy + dz * dz)
    return azimuth, elevation, range_km
