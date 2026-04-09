from __future__ import annotations

import math
import struct
import zlib
from typing import Optional, Sequence, Tuple

from obstruction_analysis import grid_to_sky


RGB = Tuple[int, int, int]


def render_export_png(
    layer_name: str,
    current_map: Optional[Sequence[Sequence[float]]],
    average_map: Optional[Sequence[Sequence[float]]],
    obstruction_mask: Optional[Sequence[Sequence[int]]],
    track_map: Optional[Sequence[Sequence[float]]],
    map_projection: Optional[dict],
    dish: Optional[dict],
    clusters: Optional[Sequence[dict]],
    live_satellites: Optional[Sequence[dict]],
    size: int = 1024,
) -> bytes:
    width = size
    height = size
    pixels = bytearray(width * height * 3)
    grid_width, grid_height = _detect_grid_size(current_map, average_map, obstruction_mask, track_map)

    _fill_background(pixels, width, height, (5, 8, 12))
    _draw_reference_rings(pixels, width, height)

    if layer_name == "current":
        _draw_signal_grid(pixels, width, height, current_map, map_projection)
    elif layer_name == "mask":
        _draw_mask_grid(pixels, width, height, obstruction_mask, map_projection)
    elif layer_name == "tracks":
        _draw_track_grid(pixels, width, height, track_map, map_projection)
    else:
        _draw_signal_grid(pixels, width, height, average_map, map_projection)

    if obstruction_mask and layer_name in {"average", "current"}:
        _draw_mask_grid(pixels, width, height, obstruction_mask, map_projection, alpha=0.35)

    if track_map and layer_name in {"average", "current"}:
        _draw_track_grid(pixels, width, height, track_map, map_projection, alpha=0.28)

    if clusters and grid_width and grid_height:
        _draw_clusters(pixels, width, height, clusters, grid_width, grid_height, map_projection)

    if dish and dish.get("azimuth") is not None and dish.get("elevation") is not None:
        _draw_dish_vector(
            pixels,
            width,
            height,
            float(dish["azimuth"]),
            float(dish["elevation"]),
            map_projection,
        )

    if live_satellites:
        _draw_live_satellites(pixels, width, height, live_satellites, map_projection)

    return _encode_png(width, height, pixels)


def _fill_background(pixels: bytearray, width: int, height: int, color: RGB) -> None:
    for index in range(0, width * height * 3, 3):
        pixels[index:index + 3] = bytes(color)


def _draw_reference_rings(pixels: bytearray, width: int, height: int) -> None:
    cx = width / 2.0
    cy = height / 2.0
    radius = min(width, height) * 0.48
    for fraction, color in (
        (1.0, (90, 98, 115)),
        (2.0 / 3.0, (52, 58, 70)),
        (1.0 / 3.0, (40, 45, 55)),
    ):
        _draw_circle_outline(pixels, width, height, cx, cy, radius * fraction, color)


def _draw_signal_grid(
    pixels: bytearray,
    width: int,
    height: int,
    grid: Optional[Sequence[Sequence[float]]],
    projection: Optional[dict],
    alpha: float = 0.92,
) -> None:
    if not grid:
        return

    grid_height = len(grid)
    grid_width = len(grid[0]) if grid_height else 0
    point_radius = max(2, int((min(width, height) * 0.48) / max(grid_width, grid_height, 1)))

    for y, row in enumerate(grid):
        for x, value in enumerate(row):
            if value is None or value < 0:
                continue
            color = _signal_color(float(value))
            px, py = _project_grid_to_canvas(x, y, grid_width, grid_height, width, height, projection)
            _draw_square(pixels, width, height, px, py, point_radius, color, alpha=alpha)


def _draw_mask_grid(
    pixels: bytearray,
    width: int,
    height: int,
    mask: Optional[Sequence[Sequence[int]]],
    projection: Optional[dict],
    alpha: float = 0.86,
) -> None:
    if not mask:
        return

    grid_height = len(mask)
    grid_width = len(mask[0]) if grid_height else 0
    point_radius = max(2, int((min(width, height) * 0.48) / max(grid_width, grid_height, 1)))

    for y, row in enumerate(mask):
        for x, cell in enumerate(row):
            if not cell:
                continue
            px, py = _project_grid_to_canvas(x, y, grid_width, grid_height, width, height, projection)
            _draw_square(pixels, width, height, px, py, point_radius, (230, 92, 54), alpha=alpha)


def _draw_track_grid(
    pixels: bytearray,
    width: int,
    height: int,
    track_map: Optional[Sequence[Sequence[float]]],
    projection: Optional[dict],
    alpha: float = 0.82,
) -> None:
    if not track_map:
        return

    grid_height = len(track_map)
    grid_width = len(track_map[0]) if grid_height else 0
    peak = max((max(row) for row in track_map), default=0.0)
    if peak <= 0:
        return

    point_radius = max(2, int((min(width, height) * 0.48) / max(grid_width, grid_height, 1)))
    for y, row in enumerate(track_map):
        for x, value in enumerate(row):
            if value <= 0:
                continue
            strength = max(0.0, min(1.0, value / peak))
            color = (
                int(30 + strength * 80),
                int(130 + strength * 90),
                int(180 + strength * 70),
            )
            px, py = _project_grid_to_canvas(x, y, grid_width, grid_height, width, height, projection)
            _draw_square(pixels, width, height, px, py, point_radius, color, alpha=alpha * strength)


def _draw_clusters(
    pixels: bytearray,
    width: int,
    height: int,
    clusters: Sequence[dict],
    grid_width: int,
    grid_height: int,
    projection: Optional[dict],
) -> None:
    for cluster in clusters:
        for cell_x, cell_y in cluster.get("cells", []):
            px, py = _project_grid_to_canvas(cell_x, cell_y, grid_width, grid_height, width, height, projection)
            _draw_square(pixels, width, height, px, py, 2, (255, 190, 90), alpha=0.55)
        centroid = cluster.get("centroid", {})
        if "azimuth" in centroid and "elevation" in centroid:
            px, py = _project_sky_to_canvas(float(centroid["azimuth"]), float(centroid["elevation"]), width, height, projection)
            _draw_cross(pixels, width, height, px, py, size=6, color=(255, 227, 120))


def _draw_dish_vector(
    pixels: bytearray,
    width: int,
    height: int,
    azimuth: float,
    elevation: float,
    projection: Optional[dict],
) -> None:
    cx = width / 2.0
    cy = height / 2.0
    px, py = _project_sky_to_canvas(azimuth, elevation, width, height, projection)
    _draw_line(pixels, width, height, cx, cy, px, py, (255, 255, 255))
    _draw_cross(pixels, width, height, px, py, size=5, color=(255, 255, 255))


def _draw_live_satellites(
    pixels: bytearray,
    width: int,
    height: int,
    live_satellites: Sequence[dict],
    projection: Optional[dict],
) -> None:
    for satellite in live_satellites:
        px, py = _project_sky_to_canvas(float(satellite["azimuth"]), float(satellite["elevation"]), width, height, projection)
        _draw_square(pixels, width, height, px, py, 3, (82, 214, 246), alpha=0.95)


def _project_grid_to_canvas(
    x: int,
    y: int,
    grid_width: int,
    grid_height: int,
    width: int,
    height: int,
    projection: Optional[dict],
) -> Tuple[float, float]:
    if projection:
        source_center_x = float(projection.get("center_x", (grid_width - 1) / 2.0 if grid_width else 0.0))
        source_center_y = float(projection.get("center_y", (grid_height - 1) / 2.0 if grid_height else 0.0))
        source_radius = max(1.0, float(projection.get("radius", min(grid_width, grid_height) / 2.0 if grid_width and grid_height else 1.0)))
        dx = ((x + 0.5) - source_center_x) / source_radius
        dy = ((y + 0.5) - source_center_y) / source_radius
        canvas_radius = min(width, height) * 0.48
        cx = width / 2.0
        cy = height / 2.0
        return cx + dx * canvas_radius, cy + dy * canvas_radius

    azimuth, elevation = grid_to_sky(x, y, grid_width, grid_height, projection)
    return _project_sky_to_canvas(azimuth, elevation, width, height, projection)


def _project_sky_to_canvas(
    azimuth: float,
    elevation: float,
    width: int,
    height: int,
    projection: Optional[dict],
) -> Tuple[float, float]:
    radius = min(width, height) * 0.48
    cx = width / 2.0
    cy = height / 2.0
    minimum_elevation = float((projection or {}).get("min_elevation_deg", 0.0) or 0.0)
    radial = ((90.0 - elevation) / max(1.0, 90.0 - minimum_elevation)) * radius
    theta = math.radians(azimuth)
    return cx + math.sin(theta) * radial, cy - math.cos(theta) * radial


def _signal_color(value: float) -> RGB:
    value = max(0.0, min(1.0, value))
    red = int((1.0 - value) * 220 + 18)
    green = int(value * 215 + 30)
    blue = int(52 + value * 35)
    return red, green, blue


def _draw_square(
    pixels: bytearray,
    width: int,
    height: int,
    cx: float,
    cy: float,
    radius: int,
    color: RGB,
    alpha: float,
) -> None:
    center_x = int(round(cx))
    center_y = int(round(cy))
    for y in range(max(0, center_y - radius), min(height, center_y + radius + 1)):
        for x in range(max(0, center_x - radius), min(width, center_x + radius + 1)):
            _blend_pixel(pixels, width, x, y, color, alpha)


def _draw_cross(
    pixels: bytearray,
    width: int,
    height: int,
    cx: float,
    cy: float,
    size: int,
    color: RGB,
) -> None:
    center_x = int(round(cx))
    center_y = int(round(cy))
    for offset in range(-size, size + 1):
        x = center_x + offset
        y = center_y + offset
        if 0 <= x < width and 0 <= center_y < height:
            _blend_pixel(pixels, width, x, center_y, color, 0.95)
        if 0 <= center_x < width and 0 <= center_y + offset < height:
            _blend_pixel(pixels, width, center_x, center_y + offset, color, 0.95)


def _draw_line(
    pixels: bytearray,
    width: int,
    height: int,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    color: RGB,
) -> None:
    dx = int(round(abs(x1 - x0)))
    dy = int(round(abs(y1 - y0)))
    steps = max(dx, dy, 1)
    for step in range(steps + 1):
        t = step / steps
        x = int(round(x0 + (x1 - x0) * t))
        y = int(round(y0 + (y1 - y0) * t))
        if 0 <= x < width and 0 <= y < height:
            _blend_pixel(pixels, width, x, y, color, 0.92)


def _draw_circle_outline(
    pixels: bytearray,
    width: int,
    height: int,
    cx: float,
    cy: float,
    radius: float,
    color: RGB,
) -> None:
    segments = 256
    for index in range(segments):
        angle = (index / segments) * math.pi * 2.0
        x = int(round(cx + math.cos(angle) * radius))
        y = int(round(cy + math.sin(angle) * radius))
        if 0 <= x < width and 0 <= y < height:
            _blend_pixel(pixels, width, x, y, color, 0.75)


def _blend_pixel(pixels: bytearray, width: int, x: int, y: int, color: RGB, alpha: float) -> None:
    offset = (y * width + x) * 3
    for channel in range(3):
        current = pixels[offset + channel]
        blended = int(round(current * (1.0 - alpha) + color[channel] * alpha))
        pixels[offset + channel] = max(0, min(255, blended))


def _encode_png(width: int, height: int, pixels: bytearray) -> bytes:
    header = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0)

    raw_rows = bytearray()
    row_bytes = width * 3
    for y in range(height):
        raw_rows.append(0)
        start = y * row_bytes
        raw_rows.extend(pixels[start:start + row_bytes])

    compressed = zlib.compress(bytes(raw_rows), level=9)
    return b"".join(
        [
            header,
            _png_chunk(b"IHDR", ihdr),
            _png_chunk(b"IDAT", compressed),
            _png_chunk(b"IEND", b""),
        ]
    )


def _png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    return (
        struct.pack("!I", len(data))
        + chunk_type
        + data
        + struct.pack("!I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    )


def _detect_grid_size(*grids: Optional[Sequence[Sequence[float]]]) -> Tuple[int, int]:
    for grid in grids:
        if grid and len(grid) > 0 and len(grid[0]) > 0:
            return len(grid[0]), len(grid)
    return 0, 0
