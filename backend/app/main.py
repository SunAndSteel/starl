from __future__ import annotations

from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path

from fastapi import Body, FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from monitor_service import MonitorService

from .config import get_settings
from .service import TelemetryService
from .transport import WebSocketHub


settings = get_settings()
if not logging.getLogger().handlers:
    logging.basicConfig(level=os.getenv("STARLINK_LOG_LEVEL", "INFO").upper())

hub = WebSocketHub()
sky_service = MonitorService()
service = TelemetryService(settings, hub, sky_monitor=sky_service)


@asynccontextmanager
async def lifespan(_: FastAPI):
    import asyncio

    sky_service.start()
    service.start(asyncio.get_running_loop())
    try:
        yield
    finally:
        service.stop()
        sky_service.stop()


app = FastAPI(
    title=settings.api_title,
    version=settings.api_version,
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "connections": await hub.connection_count(),
            "sky_ready": sky_service.state_snapshot().get("ready", False),
        }
    )


@app.get("/api/state")
async def state() -> JSONResponse:
    snapshot = service.get_snapshot()
    if snapshot is None:
        snapshot = {
            "type": "telemetry",
            "generated_at": None,
            "status": {},
            "timeline": [],
            "throughput": {},
            "bufferbloat": [],
            "alerts": {},
            "sky": sky_service.state_snapshot(),
            "meta": {
                "sample_count": 0,
                "worker_error": None,
            },
        }
    return JSONResponse(snapshot)


@app.get("/api/export")
async def export_png(
    layer: str = Query(default="average", pattern="^(current|average|mask|tracks)$"),
    size: int = Query(default=1024, ge=256, le=2048),
) -> Response:
    payload = sky_service.export_png(layer_name=layer, size=size)
    return Response(
        content=payload,
        media_type="image/png",
        headers={"Content-Disposition": f'attachment; filename="starlink-{layer}.png"'},
    )


@app.post("/api/reset")
async def reset_obstruction_map() -> JSONResponse:
    return JSONResponse(sky_service.reset())


@app.post("/api/tle/refresh")
async def refresh_tle() -> JSONResponse:
    return JSONResponse(sky_service.refresh_tle())


@app.post("/api/observer")
async def set_observer(payload: dict = Body(...)) -> JSONResponse:
    return JSONResponse(
        sky_service.set_observer(
            latitude=float(payload["latitude"]),
            longitude=float(payload["longitude"]),
            altitude_m=float(payload.get("altitude_m", 0.0)),
        )
    )


@app.websocket("/ws")
async def websocket_stream(websocket: WebSocket) -> None:
    await hub.connect(websocket)
    snapshot = service.get_snapshot()
    if snapshot is not None:
        await websocket.send_json(snapshot)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(websocket)
    except Exception:
        await hub.disconnect(websocket)


if settings.frontend_dist_dir.exists():
    assets_dir = settings.frontend_dist_dir / "assets"
    fonts_dir = settings.frontend_dist_dir / "fonts"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")
    if fonts_dir.exists():
        app.mount("/fonts", StaticFiles(directory=fonts_dir), name="fonts")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(settings.frontend_dist_dir / "index.html")

    @app.get("/favicon.ico")
    async def favicon() -> Response:
        favicon_path = settings.frontend_dist_dir / "favicon.ico"
        if favicon_path.exists():
            return FileResponse(favicon_path)
        return Response(status_code=204)
else:
    @app.get("/")
    async def index() -> JSONResponse:
        return JSONResponse(
            {
                "message": "Frontend build not found. Start Vite in frontend/ or build it to frontend/dist.",
                "ws": "/ws",
            }
        )
