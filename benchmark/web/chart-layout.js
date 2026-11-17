/** Keep every hovered Thinking label anchored, avoiding other labels and active point markers. */
export function placeThinkingLabels(candidates, bounds) {
  const occupied = candidates.map(point => ({ x: point.x - 8, y: point.y - 8, w: 16, h: 16 }));
  const result = [];
  for (const candidate of candidates) {
    const positions = [];
    for (let dy = -80; dy <= 80; dy += 16) for (let dx = -96; dx <= 96; dx += 16) {
      const box = { x: candidate.x + dx, y: candidate.y + dy, w: candidate.width, h: 16 };
      if (box.x < bounds.left || box.x + box.w > bounds.right || box.y < bounds.top || box.y + box.h > bounds.bottom || occupied.some(other => intersects(box, other))) continue;
      const endX = Math.max(box.x, Math.min(box.x + box.w, candidate.x)), endY = Math.max(box.y, Math.min(box.y + box.h, candidate.y));
      positions.push({ box, endX, endY, distance: Math.hypot(endX - candidate.x, endY - candidate.y) });
    }
    const best = positions.sort((a,b) => a.distance - b.distance)[0];
    if (!best) continue;
    occupied.push({ x: best.box.x - 4, y: best.box.y - 3, w: best.box.w + 8, h: best.box.h + 6 });
    result.push({ ...candidate, ...best });
  }
  return result;
}

const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
/** Place model names near their anchors within a width-based label budget; details retain omitted names. */
export function placeChartLabels(candidates, points, bounds) {
  const occupied = points.map(point => ({ x: point.x - 9, y: point.y - 9, w: 18, h: 18 }));
  const placed = [], placedGroups = new Set();
  for (const candidate of candidates) {
    if (placed.length >= (bounds.maxLabels ?? Infinity)) break;
    if (candidate.group && placedGroups.has(candidate.group)) continue;
    let chosen;
    for (const dy of [20, -20, 30, -30, 44, -44]) {
      for (const dx of [12, -candidate.width - 12, -candidate.width / 2]) {
        const box = { x: candidate.x + dx, y: candidate.y + dy - 11, w: candidate.width, h: 15 };
        if (box.x < bounds.left || box.x + box.w > bounds.right || box.y < bounds.top || box.y + box.h > bounds.bottom || occupied.some(other => (!candidate.selected || other.label) && intersects(box, other))) continue;
        chosen = box; break;
      }
      if (chosen) break;
    }
    if (!chosen) continue;
    occupied.push({ x: chosen.x - 5, y: chosen.y - 4, w: chosen.w + 10, h: chosen.h + 8, label: true });
    placed.push({ ...candidate, box: chosen });
    if (candidate.group) placedGroups.add(candidate.group);
  }
  return placed;
}
