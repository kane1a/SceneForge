const ZOOM_PERCENTAGES = Object.freeze([80, 90, 100, 110, 125, 150, 175, 200]);
const STEP_PERCENTAGES = Object.freeze([50, 60, 70, ...ZOOM_PERCENTAGES]);

function normalizeZoomFactor(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(2, Math.max(0.5, parsed)) : 1;
}

function stepZoomFactor(value, delta) {
  const current = Math.round(normalizeZoomFactor(value) * 100);
  const direction = Math.sign(Number(delta) || 0);
  if (!direction) return current / 100;
  const next = direction > 0
    ? STEP_PERCENTAGES.find((percent) => percent > current) ?? 200
    : [...STEP_PERCENTAGES].reverse().find((percent) => percent < current) ?? 50;
  return next / 100;
}

module.exports = { ZOOM_PERCENTAGES, normalizeZoomFactor, stepZoomFactor };
