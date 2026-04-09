#!/usr/bin/env python3
"""
Starlink Monitor — Dashboard terminal pour cake-autorate
Prérequis : pip install rich grpcio grpcio-reflection protobuf
Usage     : python starlink_monitor.py [--host 192.168.100.1:9200]
"""

import argparse
import sys
import time
import math
import collections
from datetime import datetime
from typing import Optional, Deque

# ── Vérification des dépendances ──────────────────────────────────────────────
try:
    from rich.console import Console
    from rich.layout import Layout
    from rich.live import Live
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text
    from rich.columns import Columns
    from rich import box
except ImportError:
    print("Dépendance manquante. Installez : pip install rich")
    sys.exit(1)

try:
    import grpc
except ImportError:
    print("Dépendance manquante. Installez : pip install grpcio grpcio-reflection protobuf")
    sys.exit(1)

# ── Import du module starlink (doit être dans le même dossier) ─────────────────
try:
    import starlink_grpc
except ImportError:
    print("Fichier starlink_grpc.py introuvable dans le répertoire courant.")
    print("Placez starlink_grpc.py dans le même dossier que ce script.")
    sys.exit(1)

# ── Constantes ────────────────────────────────────────────────────────────────
HISTORY_LEN     = 60      # points conservés pour les sparklines (secondes)
POLL_INTERVAL   = 1.0     # secondes entre chaque poll
LATENCY_WARN    = 40.0    # ms — seuil avertissement bufferbloat
LATENCY_CRIT    = 80.0    # ms — seuil critique
DROP_WARN       = 0.01    # 1 % perte — avertissement
DROP_CRIT       = 0.05    # 5 % perte — critique

# Blocs unicode pour sparklines
SPARK_CHARS = " ▁▂▃▄▅▆▇█"

console = Console()


# ── Accumulateur de statistiques sur toute la durée d'exécution ───────────────

class RunningStats:
    """Calcule min / moy / max / écart-type en O(1) mémoire (algorithme de Welford)."""
    __slots__ = ("n", "_mean", "_M2", "_min", "_max")

    def __init__(self):
        self.n    = 0
        self._mean = 0.0
        self._M2   = 0.0
        self._min  = float("inf")
        self._max  = float("-inf")

    def add(self, value: Optional[float]) -> None:
        if value is None:
            return
        self.n += 1
        delta      = value - self._mean
        self._mean += delta / self.n
        self._M2   += delta * (value - self._mean)
        if value < self._min:
            self._min = value
        if value > self._max:
            self._max = value

    @property
    def mean(self) -> Optional[float]:
        return self._mean if self.n > 0 else None

    @property
    def minimum(self) -> Optional[float]:
        return self._min if self.n > 0 else None

    @property
    def maximum(self) -> Optional[float]:
        return self._max if self.n > 0 else None

    @property
    def stdev(self) -> Optional[float]:
        if self.n < 2:
            return None
        return math.sqrt(self._M2 / self.n)


# ── Moteur CAKE-Autorate ──────────────────────────────────────────────────────

# Paramètres de l'algorithme (modifiables selon votre lien)
CAKE_LATENCY_TARGET  = 45.0    # ms  — latence visée (bufferbloat budget)
CAKE_LATENCY_FLOOR   = 15.0    # ms  — on ne descend pas en dessous (latence physique min)
CAKE_DROP_TARGET     = 0.005   # 0.5 % — seuil perte acceptable
CAKE_MIN_DOWN        =  5_000_000   # 5 Mbps  — plancher descend.
CAKE_MAX_DOWN        = 250_000_000  # 250 Mbps — plafond descend.
CAKE_MIN_UP          =  1_000_000   # 1 Mbps  — plancher montant
CAKE_MAX_UP          =  25_000_000  # 25 Mbps — plafond montant
CAKE_PROBE_UP_STEP   = 0.03    # +3 % par seconde en phase PROBE
CAKE_RECOVER_STEP    = 0.015   # +1.5 % par seconde en phase STABLE
CAKE_REDUCE_MILD     = 0.08    # -8 %  si latence légèrement haute
CAKE_REDUCE_HARD     = 0.20    # -20 % si latence très haute ou forte perte
CAKE_EWMA_ALPHA      = 0.25    # lissage EWMA (0 = très lent, 1 = pas de lissage)
CAKE_STABLE_SECONDS  = 10      # secondes consécutives OK → CONVERGED


class CakeAutorate:
    WINDOW = 8  # taille fenêtre (secondes)

    PHASES = ("INIT", "WARMUP", "PROBE", "HOLD", "BACKOFF", "THROTTLE")

    def __init__(self):
        self.down = CAKE_MIN_DOWN * 4
        self.up   = CAKE_MIN_UP   * 4

        self.ewma_lat = None
        self.ewma_drop = None

        self.phase = "INIT"

        # fenêtres glissantes
        self.lat_window  = collections.deque(maxlen=self.WINDOW)
        self.drop_window = collections.deque(maxlen=self.WINDOW)

        # historiques UI
        self.hist_down  = collections.deque(maxlen=HISTORY_LEN)
        self.hist_up    = collections.deque(maxlen=HISTORY_LEN)
        self.hist_phase = collections.deque(maxlen=HISTORY_LEN)

        # best
        self.best_down  = None
        self.best_up    = None
        self.best_lat   = None
        self.best_score = -1

        # état interne
        self.last_reason = "–"
        self.last_delta_d = 0.0
        self.last_delta_u = 0.0

        self.cooldown = 0

        # stats UI
        self.n_increase = 0
        self.n_decrease = 0
        self.n_throttle = 0

    # ───────────────────────────────────────────────
    def update(self, lat, drop, obs_down, obs_up):
        if lat is None:
            return

        drop = drop or 0.0

        self.lat_window.append(lat)
        self.drop_window.append(drop)

        if len(self.lat_window) < self.WINDOW:
            self.phase = "WARMUP"
            self.ewma_lat = lat
            self.ewma_drop = drop
            self._push_hist()
            return

        avg_lat  = sum(self.lat_window) / len(self.lat_window)
        avg_drop = sum(self.drop_window) / len(self.drop_window)

        # ── SCORE ───────────────────────────────
        lat_ratio  = avg_lat / CAKE_LATENCY_TARGET
        drop_ratio = avg_drop / CAKE_DROP_TARGET if CAKE_DROP_TARGET > 0 else 0

        score = 1.0 - (lat_ratio * 0.7 + drop_ratio * 0.3)
        score = max(-1, min(1, score))

        # ── zones hysteresis ────────────────────
        bloat_high = avg_lat > CAKE_LATENCY_TARGET * 1.3 or avg_drop > CAKE_DROP_TARGET * 3
        bloat_low  = avg_lat > CAKE_LATENCY_TARGET
        safe       = avg_lat < CAKE_LATENCY_TARGET * 0.9 and avg_drop < CAKE_DROP_TARGET * 2

        prev_down = self.down
        prev_up   = self.up

        # cooldown anti oscillation
        if self.cooldown > 0:
            self.cooldown -= 1
            self.phase = "HOLD"
            self.last_reason = "cooldown"
            self._push_hist()
            return

        # ── décisions ──────────────────────────
        if bloat_high:
            self.phase = "THROTTLE"
            self.down *= (1 - CAKE_REDUCE_HARD)
            self.up   *= (1 - CAKE_REDUCE_HARD)
            self.cooldown = 2
            self.n_throttle += 1
            self.n_decrease += 1
            self.last_reason = f"hard bloat {avg_lat:.0f}ms"

        elif bloat_low:
            self.phase = "BACKOFF"
            self.down *= (1 - CAKE_REDUCE_MILD)
            self.up   *= (1 - CAKE_REDUCE_MILD)
            self.n_decrease += 1
            self.last_reason = f"soft bloat {avg_lat:.0f}ms"

        elif safe:
            self.phase = "PROBE"

            step = CAKE_PROBE_UP_STEP * (1 + score)

            self.down *= (1 + step)
            self.up   *= (1 + step)

            self.n_increase += 1
            self.last_reason = f"probe score={score:.2f}"

        else:
            self.phase = "HOLD"
            self.last_reason = f"neutral {avg_lat:.0f}ms"

        # ── limites ────────────────────────────
        self.down = min(max(self.down, CAKE_MIN_DOWN), CAKE_MAX_DOWN)
        self.up   = min(max(self.up,   CAKE_MIN_UP),   CAKE_MAX_UP)

        # ── best (robuste) ─────────────────────
        if score > self.best_score and not bloat_high:
            self.best_score = score
            self.best_down  = self.down
            self.best_up    = self.up
            self.best_lat   = avg_lat

        # ── delta ──────────────────────────────
        self.last_delta_d = self.down - prev_down
        self.last_delta_u = self.up   - prev_up
        
        # approx EWMA à partir de la moyenne fenêtre
        self.ewma_lat = avg_lat
        self.ewma_drop = avg_drop

        self._push_hist()

    # ───────────────────────────────────────────────
    def _push_hist(self):
        self.hist_down.append(self.down)
        self.hist_up.append(self.up)
        self.hist_phase.append(self.PHASES.index(self.phase))

    # ───────────────────────────────────────────────
    @property
    def phase_style(self):
        return {
            "INIT":     "dim",
            "WARMUP":   "dim",
            "PROBE":    "yellow",
            "HOLD":     "cyan",
            "BACKOFF":  "magenta",
            "THROTTLE": "bold red",
        }.get(self.phase, "white")

    @property
    def phase_icon(self):
        return {
            "INIT":     "…",
            "WARMUP":   "⏳",
            "PROBE":    "🔍",
            "HOLD":     "➖",
            "BACKOFF":  "↘",
            "THROTTLE": "⚡",
        }.get(self.phase, "")

    @property
    def trend_down(self):
        if self.last_delta_d > 1e4: return "↑"
        if self.last_delta_d < -1e4: return "↓"
        return "→"

    @property
    def trend_up(self):
        if self.last_delta_u > 1e3: return "↑"
        if self.last_delta_u < -1e3: return "↓"
        return "→"

def sparkline(values: list, width: int = 30) -> str:
    """Génère une sparkline unicode sur `width` caractères."""
    if not values:
        return "─" * width
    # Prendre les `width` dernières valeurs
    vals = list(values)[-width:]
    # Filtrer les None
    clean = [v for v in vals if v is not None]
    if not clean:
        return "─" * width
    vmin = min(clean)
    vmax = max(clean)
    rng  = vmax - vmin if vmax != vmin else 1
    out  = []
    for v in vals:
        if v is None:
            out.append("·")
        else:
            idx = int((v - vmin) / rng * (len(SPARK_CHARS) - 1))
            out.append(SPARK_CHARS[idx])
    return "".join(out)


def fmt_bps(bps: Optional[float]) -> str:
    if bps is None:
        return "–"
    if bps >= 1e9:
        return f"{bps/1e9:.2f} Gbps"
    if bps >= 1e6:
        return f"{bps/1e6:.1f} Mbps"
    if bps >= 1e3:
        return f"{bps/1e3:.0f} Kbps"
    return f"{bps:.0f} bps"


def fmt_ms(ms: Optional[float]) -> str:
    return f"{ms:.1f} ms" if ms is not None else "–"


def fmt_pct(frac: Optional[float]) -> str:
    return f"{frac*100:.2f}%" if frac is not None else "–"


def fmt_uptime(seconds: Optional[int]) -> str:
    if seconds is None:
        return "–"
    h, r = divmod(seconds, 3600)
    m, s = divmod(r, 60)
    return f"{h}h {m:02d}m {s:02d}s"


def latency_style(ms: Optional[float]) -> str:
    if ms is None:
        return "dim"
    if ms >= LATENCY_CRIT:
        return "bold red"
    if ms >= LATENCY_WARN:
        return "yellow"
    return "bold green"


def drop_style(frac: Optional[float]) -> str:
    if frac is None:
        return "dim"
    if frac >= DROP_CRIT:
        return "bold red"
    if frac >= DROP_WARN:
        return "yellow"
    return "bold green"


def state_style(state: str) -> str:
    return {
        "CONNECTED":         "bold green",
        "BOOTING":           "yellow",
        "SEARCHING":         "yellow",
        "STOWED":            "dim",
        "OBSTRUCTED":        "bold red",
        "NO_SATS":           "bold red",
        "NO_DOWNLINK":       "bold red",
        "NO_PINGS":          "bold red",
        "THERMAL_SHUTDOWN":  "bold red",
    }.get(state, "dim white")


def bufferbloat_score(latencies: list, drops: list) -> tuple[str, str]:
    """Retourne (grade A-F, style rich) basé sur les 60 dernières secondes."""
    clean_lat = [l for l in latencies if l is not None]
    if not clean_lat:
        return "?", "dim"
    avg_lat  = sum(clean_lat) / len(clean_lat)
    avg_drop = sum(drops) / len(drops) if drops else 0
    if avg_lat < 30 and avg_drop < 0.005:
        return "A", "bold green"
    if avg_lat < 50 and avg_drop < 0.01:
        return "B", "green"
    if avg_lat < 80 and avg_drop < 0.02:
        return "C", "yellow"
    if avg_lat < 120 and avg_drop < 0.05:
        return "D", "bold yellow"
    return "F", "bold red"


def active_alerts(alerts: dict) -> list[str]:
    return [
        k.replace("alert_", "").replace("_", " ").title()
        for k, v in alerts.items() if v
    ]


# ── Rendu du dashboard ────────────────────────────────────────────────────────

def build_dashboard(
    status:       Optional[dict],
    obs:          Optional[dict],
    alerts:       Optional[dict],
    hist_lat:     Deque,
    hist_drop:    Deque,
    hist_down:    Deque,
    hist_up:      Deque,
    hist_power:   Deque,
    all_lat:      "RunningStats",
    all_drop:     "RunningStats",
    all_down:     "RunningStats",
    all_up:       "RunningStats",
    cake:         "CakeAutorate",
    start_time:   float,
    last_counter: Optional[int],
    error_msg:    Optional[str],
    poll_count:   int,
) -> Layout:

    now_str = datetime.now().strftime("%H:%M:%S")
    ts_text = Text(f" 📡 Starlink Monitor  —  {now_str}  (poll #{poll_count})", style="bold white on blue")

    # ── Panneau CONNEXION ──────────────────────────────────────────────────────
    conn_table = Table(box=None, padding=(0, 1), show_header=False)
    conn_table.add_column(style="dim", width=22)
    conn_table.add_column()

    if status:
        state = status.get("state", "UNKNOWN")
        conn_table.add_row("État",      Text(state, style=state_style(state)))
        conn_table.add_row("Uptime",    fmt_uptime(status.get("uptime")))
        conn_table.add_row("ID",        str(status.get("id") or "–")[:28])
        conn_table.add_row("Firmware",  str(status.get("software_version") or "–")[:28])
        conn_table.add_row("Azimuth",   f"{status.get('direction_azimuth', 0):.1f}°" if status.get('direction_azimuth') is not None else "–")
        conn_table.add_row("Élévation", f"{status.get('direction_elevation', 0):.1f}°" if status.get('direction_elevation') is not None else "–")
        obstr = status.get("fraction_obstructed")
        conn_table.add_row("Obstruction", Text(fmt_pct(obstr), style="bold red" if (obstr or 0) > 0.01 else "green"))
    else:
        conn_table.add_row("État", Text("Non connecté", style="bold red"))

    panel_conn = Panel(conn_table, title="[bold]Connexion[/]", border_style="blue", padding=(0, 1))

    # ── Panneau MÉTRIQUES TEMPS RÉEL ──────────────────────────────────────────
    latest_lat  = hist_lat[-1]  if hist_lat  else None
    latest_drop = hist_drop[-1] if hist_drop else None
    latest_down = hist_down[-1] if hist_down else None
    latest_up   = hist_up[-1]   if hist_up   else None
    latest_pwr  = hist_power[-1] if hist_power else None

    grade, grade_style = bufferbloat_score(list(hist_lat), list(hist_drop))

    rt_table = Table(box=None, padding=(0, 1), show_header=False)
    rt_table.add_column(style="dim", width=22)
    rt_table.add_column()

    rt_table.add_row(
        "Latence (PoP)",
        Text(fmt_ms(latest_lat), style=latency_style(latest_lat))
    )
    rt_table.add_row(
        "Perte paquets",
        Text(fmt_pct(latest_drop), style=drop_style(latest_drop))
    )
    rt_table.add_row(
        "↓ Débit descend.",
        Text(fmt_bps(latest_down), style="bold cyan")
    )
    rt_table.add_row(
        "↑ Débit montant",
        Text(fmt_bps(latest_up), style="bold magenta")
    )
    rt_table.add_row(
        "Puissance",
        f"{latest_pwr:.1f} W" if latest_pwr is not None else "–"
    )
    rt_table.add_row(
        "Bufferbloat",
        Text(f" {grade} ", style=f"{grade_style} on default")
    )

    panel_rt = Panel(rt_table, title="[bold]Temps réel[/]", border_style="cyan", padding=(0, 1))

    # ── Panneau SPARKLINES ────────────────────────────────────────────────────
    spark_table = Table(box=None, padding=(0, 1), show_header=False)
    spark_table.add_column(style="dim", width=18)
    spark_table.add_column(style="white", no_wrap=True)
    spark_table.add_column(style="dim", width=10, justify="right")

    def spark_row(label, data, fmt_fn, color):
        vals    = list(data)
        last    = vals[-1] if vals else None
        spark   = sparkline(vals, width=40)
        spark_t = Text(spark, style=color, no_wrap=True)
        spark_table.add_row(label, spark_t, fmt_fn(last))

    spark_row("Latence (ms)",  hist_lat,   fmt_ms,  latency_style(latest_lat))
    spark_row("Perte (%)",     [d*100 if d is not None else None for d in hist_drop],
                                           lambda x: f"{x:.2f}%" if x is not None else "–",
                                           drop_style(latest_drop))
    spark_row("↓ Mbps",        [d/1e6 if d is not None else None for d in hist_down],
                                           lambda x: f"{x:.1f}" if x is not None else "–",
                                           "cyan")
    spark_row("↑ Mbps",        [u/1e6 if u is not None else None for u in hist_up],
                                           lambda x: f"{x:.1f}" if x is not None else "–",
                                           "magenta")
    if any(p is not None for p in hist_power):
        spark_row("Puissance (W)", hist_power,
                                           lambda x: f"{x:.0f}W" if x is not None else "–",
                                           "yellow")

    panel_spark = Panel(spark_table, title=f"[bold]Historique 60 s[/]", border_style="white", padding=(0, 1))

    # ── Panneau ALERTES ───────────────────────────────────────────────────────
    active = active_alerts(alerts) if alerts else []
    if active:
        alert_text = Text()
        for a in active:
            alert_text.append(f"⚠ {a}\n", style="bold red")
        panel_alerts = Panel(alert_text, title="[bold red]Alertes actives[/]", border_style="red", padding=(0, 1))
    else:
        panel_alerts = Panel(Text("✓ Aucune alerte", style="bold green"),
                             title="[bold]Alertes[/]", border_style="green", padding=(0, 1))

    # ── Panneau STATS — toute la durée d'exécution ────────────────────────────
    elapsed   = time.time() - start_time
    el_h, el_r = divmod(int(elapsed), 3600)
    el_m, el_s = divmod(el_r, 60)
    elapsed_str = f"{el_h}h {el_m:02d}m {el_s:02d}s" if el_h else f"{el_m}m {el_s:02d}s"

    stats_table = Table(box=None, padding=(0, 1), show_header=False)
    stats_table.add_column(style="dim", width=18)
    stats_table.add_column(justify="right", width=13)
    stats_table.add_column(justify="right", width=13)
    stats_table.add_column(justify="right", width=13)
    stats_table.add_column(justify="right", width=13)
    stats_table.add_row(
        "",
        Text("Moy",    style="dim"),
        Text("Min",    style="dim"),
        Text("Max",    style="dim"),
        Text("σ",      style="dim"),
    )

    def stats_row_all(label, rs: RunningStats, fmt_fn, avg_style_fn=None):
        if rs.n == 0:
            stats_table.add_row(label, "–", "–", "–", "–")
            return
        avg_style = avg_style_fn(rs.mean) if avg_style_fn else "white"
        sd = rs.stdev
        stats_table.add_row(
            label,
            Text(fmt_fn(rs.mean),    style=avg_style),
            Text(fmt_fn(rs.minimum), style="dim"),
            Text(fmt_fn(rs.maximum), style="dim"),
            Text(fmt_fn(sd) if sd is not None else "–", style="dim"),
        )

    stats_row_all("Latence",   all_lat,  fmt_ms,  latency_style)
    stats_row_all("Perte",     all_drop, fmt_pct, drop_style)
    stats_row_all("↓ Débit",   all_down, fmt_bps)
    stats_row_all("↑ Débit",   all_up,   fmt_bps)

    panel_stats = Panel(
        stats_table,
        title=f"[bold]Statistiques — {elapsed_str}  ({all_lat.n} éch.)[/]",
        border_style="white",
        padding=(0, 1),
    )

    # ── Panneau CAKE AUTORATE ─────────────────────────────────────────────────
    cake_table = Table(box=None, padding=(0, 1), show_header=False)
    cake_table.add_column(style="dim",   width=20)
    cake_table.add_column(width=16)
    cake_table.add_column(style="dim",   width=10, justify="right")

    # Phase
    phase_text = Text(f"{cake.phase_icon} {cake.phase}", style=cake.phase_style)
    cake_table.add_row("Phase", phase_text, "")

    # Latence EWMA vs cible
    if cake.ewma_lat is not None:
        lat_vs = f"{cake.ewma_lat:.1f} ms  /  cible {CAKE_LATENCY_TARGET:.0f} ms"
        lat_style = latency_style(cake.ewma_lat)
    else:
        lat_vs, lat_style = "–", "dim"
    cake_table.add_row("Latence EWMA", Text(lat_vs, style=lat_style), "")

    # Débits recommandés avec sparklines
    def cake_spark(hist, color):
        vals  = list(hist)
        vals_ = [v / 1e6 for v in vals]   # Mbps
        spark = sparkline(vals_, width=20)
        return Text(spark, style=color, no_wrap=True)

    trend_d = cake.trend_down
    trend_u = cake.trend_up
    trend_style_d = "green" if trend_d == "↑" else ("red" if trend_d == "↓" else "dim")
    trend_style_u = "green" if trend_u == "↑" else ("red" if trend_u == "↓" else "dim")

    cake_table.add_row(
        f"↓ Recommandé {trend_d}",
        Text(fmt_bps(cake.down), style="bold cyan"),
        cake_spark(cake.hist_down, "cyan"),
    )
    cake_table.add_row(
        f"↑ Recommandé {trend_u}",
        Text(fmt_bps(cake.up), style="bold magenta"),
        cake_spark(cake.hist_up, "magenta"),
    )

    # Meilleur point stable jamais atteint
    if cake.best_down is not None:
        cake_table.add_row(
            "↓ Meilleur stable",
            Text(fmt_bps(cake.best_down), style="cyan"),
            Text(f"lat≤{cake.best_lat:.0f}ms" if cake.best_lat else "", style="dim"),
        )
        cake_table.add_row(
            "↑ Meilleur stable",
            Text(fmt_bps(cake.best_up), style="magenta"),
            "",
        )
    else:
        cake_table.add_row("Meilleur stable", Text("calibration…", style="dim"), "")

    # Décisions cumulées
    total_adj = cake.n_increase + cake.n_decrease
    cake_table.add_row(
        "Décisions",
        Text(
            f"↑{cake.n_increase}  ↓{cake.n_decrease}  ⚡{cake.n_throttle}  ({total_adj} total)",
            style="white"
        ),
        "",
    )

    # Dernier motif
    cake_table.add_row(
        "Dernier motif",
        Text(cake.last_reason[:36], style="dim italic"),
        "",
    )

    panel_cake = Panel(
        cake_table,
        title=f"[bold yellow]CAKE Autorate  —  cible latence {CAKE_LATENCY_TARGET:.0f} ms[/]",
        border_style="yellow",
        padding=(0, 1),
    )

    # ── Erreur ────────────────────────────────────────────────────────────────
    if error_msg:
        err_panel = Panel(
            Text(f"⚡ {error_msg}", style="bold red"),
            title="[bold red]Erreur gRPC[/]", border_style="red"
        )
    else:
        err_panel = None

    # ── Assemblage ────────────────────────────────────────────────────────────
    layout = Layout()
    layout.split_column(
        Layout(ts_text,     name="header", size=1),
        Layout(name="main", ratio=1),
        Layout(name="footer", size=1),
    )
    layout["main"].split_row(
        Layout(name="left",  ratio=1),
        Layout(name="right", ratio=2),
    )
    layout["left"].split_column(
        Layout(panel_conn,   name="conn"),
        Layout(panel_rt,     name="rt"),
        Layout(panel_alerts, name="alerts"),
    )
    layout["right"].split_column(
        Layout(panel_spark,  name="spark"),
        Layout(panel_cake,   name="cake"),
        Layout(panel_stats,  name="stats"),
        Layout(err_panel if err_panel else Panel("", border_style="dim", padding=(0,0)), name="err", size=3),
    )
    layout["footer"].update(
        Text(
            f" Ctrl+C Quitter  —  gRPC 192.168.100.1:9200  —  Intervalle 1 s  —  "
            f"Cible latence {CAKE_LATENCY_TARGET:.0f} ms",
            style="dim"
        )
    )

    return layout


# ── Boucle principale ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Dashboard terminal Starlink pour cake-autorate")
    parser.add_argument("--host", default="192.168.100.1:9200",
                        help="Adresse du dish Starlink (défaut : 192.168.100.1:9200)")
    args = parser.parse_args()

    hist_lat:   Deque = collections.deque(maxlen=HISTORY_LEN)
    hist_drop:  Deque = collections.deque(maxlen=HISTORY_LEN)
    hist_down:  Deque = collections.deque(maxlen=HISTORY_LEN)
    hist_up:    Deque = collections.deque(maxlen=HISTORY_LEN)
    hist_power: Deque = collections.deque(maxlen=HISTORY_LEN)

    # Accumulateurs toute durée
    all_lat   = RunningStats()
    all_drop  = RunningStats()
    all_down  = RunningStats()
    all_up    = RunningStats()
    start_time = time.time()

    # Moteur CAKE autorate
    cake = CakeAutorate()

    status    = None
    obs       = None
    alerts    = {}
    last_counter: Optional[int] = None
    error_msg: Optional[str]    = None
    poll_count = 0

    ctx = starlink_grpc.ChannelContext(target=args.host)

    with Live(console=console, refresh_per_second=2, screen=True) as live:
        try:
            while True:
                poll_count += 1
                error_msg = None

                # ── Statut ────────────────────────────────────────────────────
                try:
                    status, obs, alerts = starlink_grpc.status_data(context=ctx)
                except starlink_grpc.GrpcError as e:
                    error_msg = f"status_data : {e}"

                # ── Historique bulk (nouveaux échantillons seulement) ─────────
                try:
                    general, bulk = starlink_grpc.history_bulk_data(
                        parse_samples=5,
                        start=last_counter,
                        context=ctx,
                    )
                    last_counter = general["end_counter"]

                    lats  = bulk["pop_ping_latency_ms"]
                    drops = bulk["pop_ping_drop_rate"]
                    downs = bulk["downlink_throughput_bps"]
                    ups   = bulk["uplink_throughput_bps"]
                    pwrs  = bulk["power_w"]

                    for i in range(general["samples"]):
                        lat_v  = lats[i]  if i < len(lats)  else None
                        drop_v = drops[i] if i < len(drops) else 0.0
                        down_v = downs[i] if i < len(downs) else None
                        up_v   = ups[i]   if i < len(ups)   else None
                        pwr_v  = pwrs[i]  if i < len(pwrs)  else None

                        hist_lat.append(lat_v)
                        hist_drop.append(drop_v)
                        hist_down.append(down_v)
                        hist_up.append(up_v)
                        hist_power.append(pwr_v)

                        all_lat.add(lat_v)
                        all_drop.add(drop_v)
                        all_down.add(down_v)
                        all_up.add(up_v)

                        # Mise à jour du moteur autorate
                        cake.update(lat_v, drop_v, down_v, up_v)

                except starlink_grpc.GrpcError as e:
                    error_msg = (error_msg or "") + f"  history : {e}"

                # ── Rendu ─────────────────────────────────────────────────────
                live.update(build_dashboard(
                    status, obs, alerts,
                    hist_lat, hist_drop, hist_down, hist_up, hist_power,
                    all_lat, all_drop, all_down, all_up,
                    cake, start_time, last_counter, error_msg, poll_count,
                ))

                time.sleep(POLL_INTERVAL)

        except KeyboardInterrupt:
            pass
        finally:
            ctx.close()

    console.print("\n[bold]Dashboard arrêté.[/]")


if __name__ == "__main__":
    main()