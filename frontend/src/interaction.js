function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function createInteractionState() {
  return {
    windowMs: 5 * 60 * 1000,
    offsetMs: 0,
    hoveredEvent: null,
    dragging: false,
    dragStartX: 0,
    dragOffsetMs: 0,
  };
}

export function bindTimelineInteractions(canvas, interaction, callbacks) {
  const {
    getSnapshot,
    getTimelinePanel,
    pickEvent,
    requestRender,
    showTooltip,
    hideTooltip,
  } = callbacks;

  const relativePosition = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const insideTimeline = (event) => {
    const panel = getTimelinePanel();
    if (!panel) {
      return false;
    }
    const { x, y } = relativePosition(event);
    return x >= panel.x && x <= panel.x + panel.width && y >= panel.y && y <= panel.y + panel.height;
  };

  canvas.addEventListener(
    "wheel",
    (event) => {
      if (!insideTimeline(event)) {
        return;
      }
      const snapshot = getSnapshot();
      if (!snapshot) {
        return;
      }
      event.preventDefault();

      const panel = getTimelinePanel();
      const { x } = relativePosition(event);
      const ratio = clamp((x - panel.x) / panel.width, 0, 1);
      const latestMs = Date.parse(snapshot.generated_at);
      const visibleEnd = latestMs - interaction.offsetMs;
      const visibleStart = visibleEnd - interaction.windowMs;
      const anchorTime = visibleStart + interaction.windowMs * ratio;
      const zoomFactor = event.deltaY < 0 ? 0.84 : 1.18;
      const newWindowMs = clamp(interaction.windowMs * zoomFactor, 30_000, 30 * 60 * 1000);
      const newEnd = anchorTime + (1 - ratio) * newWindowMs;

      interaction.windowMs = newWindowMs;
      interaction.offsetMs = clamp(latestMs - newEnd, 0, 24 * 60 * 60 * 1000);
      requestRender();
    },
    { passive: false },
  );

  canvas.addEventListener("pointerdown", (event) => {
    if (!insideTimeline(event)) {
      return;
    }
    interaction.dragging = true;
    interaction.dragStartX = event.clientX;
    interaction.dragOffsetMs = interaction.offsetMs;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    const { x, y } = relativePosition(event);
    if (interaction.dragging) {
      const panel = getTimelinePanel();
      if (panel) {
        const deltaRatio = (event.clientX - interaction.dragStartX) / panel.width;
        interaction.offsetMs = clamp(
          interaction.dragOffsetMs - deltaRatio * interaction.windowMs,
          0,
          24 * 60 * 60 * 1000,
        );
        requestRender();
      }
    }

    const hovered = pickEvent(x, y);
    interaction.hoveredEvent = hovered;
    if (hovered) {
      showTooltip(x, y, hovered);
    } else {
      hideTooltip();
    }
  });

  const release = () => {
    interaction.dragging = false;
  };

  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointerleave", () => {
    release();
    interaction.hoveredEvent = null;
    hideTooltip();
  });
}
