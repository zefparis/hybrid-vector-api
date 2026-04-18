// GET http://localhost:3000/ctn/widget?key=YOUR_KEY&user=test@bank.co.za

import { Router, Request, Response } from 'express';
import { CTSService } from '../services/cts.service';

const router = Router();
const ctsService = new CTSService();

// ── SVG arc constants ─────────────────────────────────────────────────────
const CX = 60;
const CY = 60;
const R  = 50;
const CIRC      = 2 * Math.PI * R;                     // ~314.16
const TRACK_LEN = CIRC * (270 / 360);                  // ~235.62
const GAP_LEN   = CIRC - TRACK_LEN;                    // ~78.54
const START_DEG = 135;

function arcColor(score: number): string {
  if (score >= 80) return '#22C55E';
  if (score >= 60) return '#00C2FF';
  if (score >= 40) return '#F97316';
  return '#EF4444';
}

function buildSvg(score: number): string {
  const fillLen = (Math.min(100, Math.max(0, score)) / 100) * TRACK_LEN;
  const color   = arcColor(score);
  const rotate  = `rotate(${START_DEG}, ${CX}, ${CY})`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <!-- Track -->
  <circle cx="${CX}" cy="${CY}" r="${R}"
    fill="none" stroke="#1F2937" stroke-width="7" stroke-linecap="round"
    stroke-dasharray="${TRACK_LEN.toFixed(2)} ${GAP_LEN.toFixed(2)}"
    transform="${rotate}" />
  <!-- Fill -->
  <circle cx="${CX}" cy="${CY}" r="${R}"
    fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
    stroke-dasharray="${fillLen.toFixed(2)} ${CIRC.toFixed(2)}"
    transform="${rotate}" />
  <!-- Score -->
  <text x="${CX}" y="${CY - 5}"
    dominant-baseline="central" text-anchor="middle"
    fill="${color}" font-size="22" font-weight="800"
    font-family="system-ui, -apple-system, sans-serif">${score}</text>
  <!-- /100 -->
  <text x="${CX}" y="${CY + 13}"
    dominant-baseline="central" text-anchor="middle"
    fill="${color}" font-size="9" font-weight="500" opacity="0.55"
    font-family="system-ui, -apple-system, sans-serif">/100</text>
</svg>`;
}

function buildErrorSvg(): string {
  const rotate = `rotate(${START_DEG}, ${CX}, ${CY})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <circle cx="${CX}" cy="${CY}" r="${R}"
    fill="none" stroke="#374151" stroke-width="7" stroke-linecap="round"
    stroke-dasharray="${TRACK_LEN.toFixed(2)} ${GAP_LEN.toFixed(2)}"
    transform="${rotate}" />
  <circle cx="${CX}" cy="${CY}" r="${R}"
    fill="none" stroke="#EF4444" stroke-width="9" stroke-linecap="round"
    stroke-dasharray="0 ${CIRC.toFixed(2)}"
    transform="${rotate}" />
  <text x="${CX}" y="${CY}"
    dominant-baseline="central" text-anchor="middle"
    fill="#EF4444" font-size="18" font-weight="800"
    font-family="system-ui, -apple-system, sans-serif">N/A</text>
</svg>`;
}

function buildHtml(svgContent: string, label: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 120px; height: 140px;
    background: transparent;
    overflow: hidden;
  }
  .widget {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding-top: 4px;
  }
  .label {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9CA3AF;
  }
</style>
</head>
<body>
<div class="widget">
  ${svgContent}
  <span class="label">${label}</span>
</div>
</body>
</html>`;
}

// ── GET /ctn/widget ───────────────────────────────────────────────────────
router.get('/ctn/widget', async (req: Request, res: Response): Promise<void> => {
  const { key, user } = req.query as Record<string, string | undefined>;

  // Validate query params
  if (!key || typeof key !== 'string' || !user || typeof user !== 'string' || user.trim().length < 4) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.status(400).send(buildHtml(buildErrorSvg(), 'HMH Trust Score'));
    return;
  }

  try {
    const result = await ctsService.computeScore(key, user.trim());
    const svgContent = buildSvg(result.score);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buildHtml(svgContent, 'HMH Trust Score'));
  } catch {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.status(200).send(buildHtml(buildErrorSvg(), 'HMH Trust Score'));
  }
});

export default router;
