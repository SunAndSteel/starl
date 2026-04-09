export function createPanelLayout(width, height) {
  const gutter = 18;

  if (width < 980) {
    const panelHeight = (height - gutter * 3) / 2;
    return {
      throughput: { x: gutter, y: gutter, width: width - gutter * 2, height: panelHeight },
      bufferbloat: { x: gutter, y: gutter * 2 + panelHeight, width: width - gutter * 2, height: panelHeight },
    };
  }

  const panelHeight = height - gutter * 2;
  const throughputWidth = Math.round((width - gutter * 3) * 0.43);
  const bufferbloatWidth = width - gutter * 3 - throughputWidth;

  return {
    throughput: { x: gutter, y: gutter, width: throughputWidth, height: panelHeight },
    bufferbloat: { x: gutter * 2 + throughputWidth, y: gutter, width: bufferbloatWidth, height: panelHeight },
  };
}
