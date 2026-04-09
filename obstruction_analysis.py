from __future__ import annotations

from collections import deque
from typing import Any, Iterable, List, Mapping, Optional, Sequence, Tuple
import math


GridFloat = Sequence[Sequence[float]]
GridInt = List[List[int]]


OBSTRUCTION_THRESHOLD = 0.6
MIN_CLUSTER_SIZE = 6


def infer_projection(
    grid: Sequence[Sequence[float]],
    *,
    min_elevation_deg: float = 0.0,
    max_theta_deg: Optional[float] = None,
    reference_frame: Optional[str] = None,
) -> dict:
    height = len(grid)
    width = len(grid[0]) if height else 0

    valid_cells = [
        (x, y)
        for y, row in enumerate(grid)
        for x, value in enumerate(row)
        if value is not None and value >= 0
    ]

    if valid_cells:
        min_x = min(x for x, _ in valid_cells)
        max_x = max(x for x, _ in valid_cells)
        min_y = min(y for _, y in valid_cells)
        max_y = max(y for _, y in valid_cells)
        center_x = (min_x + max_x) / 2.0
        center_y = (min_y + max_y) / 2.0
        radius = max(
            math.hypot((x + 0.5) - center_x, (y + 0.5) - center_y)
            for x, y in valid_cells
        )
    else:
        center_x = (width - 1) / 2.0 if width else 0.0
        center_y = (height - 1) / 2.0 if height else 0.0
        radius = max(1.0, min(width, height) / 2.0 - 1.0)

    return {
        "width": width,
        "height": height,
        "center_x": round(center_x, 3),
        "center_y": round(center_y, 3),
        "radius": round(max(radius, 1.0), 3),
        "min_elevation_deg": round(float(min_elevation_deg or 0.0), 3),
        "max_theta_deg": None if max_theta_deg is None else round(float(max_theta_deg), 3),
        "reference_frame": reference_frame or "FRAME_EARTH",
    }


def _projection_defaults(width: int, height: int, projection: Optional[Mapping[str, Any]]) -> dict:
    if projection:
        return {
            "center_x": float(projection.get("center_x", (width - 1) / 2.0 if width else 0.0)),
            "center_y": float(projection.get("center_y", (height - 1) / 2.0 if height else 0.0)),
            "radius": max(1.0, float(projection.get("radius", min(width, height) / 2.0 - 1.0 if width and height else 1.0))),
            "min_elevation_deg": float(projection.get("min_elevation_deg", 0.0) or 0.0),
            "reference_frame": str(projection.get("reference_frame", "FRAME_EARTH")),
        }

    return {
        "center_x": (width - 1) / 2.0 if width else 0.0,
        "center_y": (height - 1) / 2.0 if height else 0.0,
        "radius": max(1.0, min(width, height) / 2.0 - 1.0 if width and height else 1.0),
        "min_elevation_deg": 0.0,
        "reference_frame": "FRAME_EARTH",
    }


def average_map(accum_map: GridFloat, count_map: Sequence[Sequence[int]]) -> List[List[float]]:
    height = len(accum_map)
    width = len(accum_map[0]) if height else 0
    average: List[List[float]] = []
    for y in range(height):
        row: List[float] = []
        for x in range(width):
            samples = count_map[y][x]
            row.append((accum_map[y][x] / samples) if samples else -1.0)
        average.append(row)
    return average


def score_map(avg_map: GridFloat) -> List[List[float]]:
    scores: List[List[float]] = []
    for row in avg_map:
        score_row: List[float] = []
        for value in row:
            score_row.append((1.0 - value) if value >= 0 else -1.0)
        scores.append(score_row)
    return scores


def grid_to_sky(
    x: float,
    y: float,
    width: int,
    height: int,
    projection: Optional[Mapping[str, Any]] = None,
) -> Tuple[float, float]:
    meta = _projection_defaults(width, height, projection)
    dx = ((x + 0.5) - meta["center_x"]) / meta["radius"]
    dy = (meta["center_y"] - (y + 0.5)) / meta["radius"]
    radial = max(0.0, min(1.0, math.hypot(dx, dy)))
    azimuth = (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0
    minimum_elevation = meta["min_elevation_deg"]
    elevation = 90.0 - radial * max(1.0, 90.0 - minimum_elevation)
    return azimuth, max(minimum_elevation, min(90.0, elevation))


def sky_to_grid(
    azimuth: float,
    elevation: float,
    width: int,
    height: int,
    projection: Optional[Mapping[str, Any]] = None,
) -> Tuple[int, int]:
    meta = _projection_defaults(width, height, projection)
    minimum_elevation = meta["min_elevation_deg"]
    radial = (90.0 - elevation) / max(1.0, 90.0 - minimum_elevation)
    radial = max(0.0, min(1.0, radial))
    theta = math.radians(azimuth % 360.0)
    x = meta["center_x"] + math.sin(theta) * meta["radius"] * radial
    y = meta["center_y"] - math.cos(theta) * meta["radius"] * radial
    return min(width - 1, max(0, int(round(x - 0.5)))), min(height - 1, max(0, int(round(y - 0.5))))


def _occupied_neighbors(mask: Sequence[Sequence[int]], x: int, y: int) -> int:
    height = len(mask)
    width = len(mask[0]) if height else 0
    total = 0
    for ny in range(max(0, y - 1), min(height, y + 2)):
        for nx in range(max(0, x - 1), min(width, x + 2)):
            if nx == x and ny == y:
                continue
            total += 1 if mask[ny][nx] else 0
    return total


def _remove_sparse_pixels(mask: Sequence[Sequence[int]], min_neighbors: int = 2) -> GridInt:
    height = len(mask)
    width = len(mask[0]) if height else 0
    filtered = [[0] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            if mask[y][x] and _occupied_neighbors(mask, x, y) >= min_neighbors:
                filtered[y][x] = 1
    return filtered


def _erode(mask: Sequence[Sequence[int]], min_neighbors: int = 4) -> GridInt:
    height = len(mask)
    width = len(mask[0]) if height else 0
    eroded = [[0] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            if mask[y][x] and _occupied_neighbors(mask, x, y) >= min_neighbors:
                eroded[y][x] = 1
    return eroded


def _dilate(mask: Sequence[Sequence[int]]) -> GridInt:
    height = len(mask)
    width = len(mask[0]) if height else 0
    dilated = [[0] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            if mask[y][x]:
                for ny in range(max(0, y - 1), min(height, y + 2)):
                    for nx in range(max(0, x - 1), min(width, x + 2)):
                        dilated[ny][nx] = 1
    return dilated


def _clean_mask(mask: Sequence[Sequence[int]]) -> GridInt:
    without_speckles = _remove_sparse_pixels(mask, min_neighbors=2)
    opened = _dilate(_erode(without_speckles, min_neighbors=4))
    return _remove_sparse_pixels(opened, min_neighbors=1)


def _cluster_cells(
    mask: Sequence[Sequence[int]],
    scores: GridFloat,
    min_cluster_size: int,
    projection: Optional[Mapping[str, Any]],
) -> Tuple[GridInt, List[dict]]:
    height = len(mask)
    width = len(mask[0]) if height else 0
    visited = [[False] * width for _ in range(height)]
    output_mask = [[0] * width for _ in range(height)]
    clusters: List[dict] = []

    for y in range(height):
        for x in range(width):
            if not mask[y][x] or visited[y][x]:
                continue

            queue = deque([(x, y)])
            visited[y][x] = True
            cells: List[Tuple[int, int]] = []

            while queue:
                cx, cy = queue.popleft()
                cells.append((cx, cy))
                for ny in range(max(0, cy - 1), min(height, cy + 2)):
                    for nx in range(max(0, cx - 1), min(width, cx + 2)):
                        if not visited[ny][nx] and mask[ny][nx]:
                            visited[ny][nx] = True
                            queue.append((nx, ny))

            if len(cells) < min_cluster_size:
                continue

            min_x = min(px for px, _ in cells)
            max_x = max(px for px, _ in cells)
            min_y = min(py for _, py in cells)
            max_y = max(py for _, py in cells)
            weighted_sum = 0.0
            weight_x = 0.0
            weight_y = 0.0
            values: List[float] = []

            for px, py in cells:
                output_mask[py][px] = 1
                weight = max(scores[py][px], 0.001)
                weighted_sum += weight
                weight_x += (px + 0.5) * weight
                weight_y += (py + 0.5) * weight
                values.append(scores[py][px])

            centroid_x = (weight_x / weighted_sum) - 0.5 if weighted_sum else (min_x + max_x) / 2
            centroid_y = (weight_y / weighted_sum) - 0.5 if weighted_sum else (min_y + max_y) / 2
            azimuth, elevation = grid_to_sky(centroid_x, centroid_y, width, height, projection)

            clusters.append(
                {
                    "size": len(cells),
                    "centroid": {
                        "x": round(centroid_x, 2),
                        "y": round(centroid_y, 2),
                        "azimuth": round(azimuth, 2),
                        "elevation": round(elevation, 2),
                    },
                    "bbox": {
                        "x0": min_x,
                        "y0": min_y,
                        "x1": max_x,
                        "y1": max_y,
                    },
                    "mean_score": round(sum(values) / len(values), 3),
                    "max_score": round(max(values), 3),
                    "cells": [[px, py] for px, py in cells],
                }
            )

    clusters.sort(key=lambda cluster: cluster["size"], reverse=True)
    return output_mask, clusters


def detect_persistent_obstructions(
    accum_map: GridFloat,
    count_map: Sequence[Sequence[int]],
    threshold: float = OBSTRUCTION_THRESHOLD,
    min_cluster_size: int = MIN_CLUSTER_SIZE,
    map_projection: Optional[Mapping[str, Any]] = None,
) -> dict:
    avg_map = average_map(accum_map, count_map)
    scores = score_map(avg_map)

    height = len(scores)
    width = len(scores[0]) if height else 0
    base_mask = [[0] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            base_mask[y][x] = 1 if scores[y][x] > threshold else 0

    cleaned_mask = _clean_mask(base_mask)
    filtered_mask, clusters = _cluster_cells(cleaned_mask, scores, min_cluster_size=min_cluster_size, projection=map_projection)
    obstructed_cells = sum(sum(row) for row in filtered_mask)

    return {
        "average_map": avg_map,
        "score_map": scores,
        "mask": filtered_mask,
        "clusters": clusters,
        "stats": {
            "threshold": threshold,
            "cluster_count": len(clusters),
            "obstructed_cells": obstructed_cells,
            "coverage": round(
                (obstructed_cells / (height * width)) if height and width else 0.0,
                4,
            ),
        },
    }
