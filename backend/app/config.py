from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    starlink_target: str = os.getenv("STARLINK_TARGET", "192.168.100.1:9200")
    poll_interval_s: float = float(os.getenv("STARLINK_POLL_INTERVAL", "1.0"))
    parse_samples: int = int(os.getenv("STARLINK_PARSE_SAMPLES", "8"))
    sample_buffer_size: int = int(os.getenv("STARLINK_SAMPLE_BUFFER_SIZE", "1800"))
    timeline_window_seconds: int = int(os.getenv("STARLINK_TIMELINE_WINDOW", "600"))
    throughput_window_seconds: int = int(os.getenv("STARLINK_THROUGHPUT_WINDOW", "60"))
    bufferbloat_window_seconds: int = int(os.getenv("STARLINK_BUFFERBLOAT_WINDOW", "900"))
    bufferbloat_bucket_count: int = int(os.getenv("STARLINK_BUFFERBLOAT_BUCKETS", "14"))
    cors_origins: tuple[str, ...] = tuple(
        origin.strip()
        for origin in os.getenv("STARLINK_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
        if origin.strip()
    )
    frontend_dist_dir: Path = ROOT_DIR / "frontend" / "dist"
    api_title: str = "Starlink Monitor"
    api_version: str = "1.0.0"


def get_settings() -> Settings:
    return Settings()
