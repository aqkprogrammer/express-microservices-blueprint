#!/usr/bin/env node
/**
 * Builds the animated architecture SVGs in docs/assets/animated/.
 *
 *   npm run diagrams:build          # or: node scripts/diagrams/build-animated-svgs.mjs
 *
 * Dependency-free (Node 22+, ESM). Every flow below is declared as data:
 * nodes/lanes with positions and labels, then ordered steps of labelled edges.
 * The renderer turns each flow into one self-contained SVG that animates with
 * inline CSS @keyframes only — no JavaScript, fonts, images or remote
 * resources, because GitHub renders SVG through <img> and strips scripts.
 *
 * Animation model (per loop): each step's edges draw in sequence (stroke
 * dash offset), a dot travels along the edge and the step label fades in;
 * completed steps stay highlighted until the loop fades out and restarts.
 * Under `prefers-reduced-motion: reduce` every step is shown statically.
 *
 * The flows mirror the real implementation (packages/contracts, apps/*). When
 * you change a flow in code, update the matching declaration here and the
 * Mermaid diagram in docs/architecture/, then re-run this script.
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'docs', 'assets', 'animated');
const MAX_BYTES = 60 * 1024;

// ── Theme ────────────────────────────────────────────────────────────────────

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const INK = '#1f2328';
const MUTED = '#59636e';
const FAINT = '#d1d9e0';
const BG = '#ffffff';

/** Node fills by role. Light, high-contrast pastels; the canvas itself is opaque. */
const KINDS = {
  client: { fill: '#f6f8fa', stroke: '#818b98' },
  gateway: { fill: '#ddf4ff', stroke: '#54aeff' },
  service: { fill: '#dafbe1', stroke: '#4ac26b' },
  worker: { fill: '#e7ecf0', stroke: '#818b98' },
  broker: { fill: '#fbefff', stroke: '#c297ff' },
  data: { fill: '#fff8c5', stroke: '#d4a72c' },
  cache: { fill: '#ffebe9', stroke: '#ff8182' },
  obs: { fill: '#fff1e5', stroke: '#fb8f44' },
  actor: { fill: '#ffebe9', stroke: '#cf222e' },
};

/** Highlight colour of an edge by meaning. */
const TONES = {
  req: '#0969da', // synchronous request
  res: '#1a7f37', // response / success
  event: '#8250df', // asynchronous message via RabbitMQ
  fail: '#cf222e', // failure path
  comp: '#bc4c00', // compensation / recovery action
  note: '#59636e',
};

// ── Small helpers ────────────────────────────────────────────────────────────

const esc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;
/** Rough text width for the system sans stack (no font metrics available offline). */
const textWidth = (text, size, bold = false) => text.length * size * (bold ? 0.6 : 0.55);
const lines = (value) => (Array.isArray(value) ? value : value ? [value] : []);

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1)
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

function arrowHead([x1, y1], [x2, y2], size = 7) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const a = angle + Math.PI * 0.85;
  const b = angle - Math.PI * 0.85;
  return `${r1(x2)},${r1(y2)} ${r1(x2 + size * Math.cos(a))},${r1(y2 + size * Math.sin(a))} ${r1(
    x2 + size * Math.cos(b),
  )},${r1(y2 + size * Math.sin(b))}`;
}

function nodeBox({ x, y, w, h, title, sub, kind = 'service' }, extraClass = '') {
  const style = KINDS[kind] ?? KINDS.service;
  const subLines = lines(sub);
  const lineH = 13;
  const blockH = 15 + subLines.length * lineH;
  let ty = y + h / 2 - blockH / 2 + 11;
  const cx = x + w / 2;
  let out = `<g${extraClass ? ` class="${extraClass}"` : ''}><rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(
    h,
  )}" rx="8" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.2"/>`;
  out += `<text x="${r1(cx)}" y="${r1(ty)}" class="nt">${esc(title)}</text>`;
  for (const line of subLines) {
    ty += lineH;
    out += `<text x="${r1(cx)}" y="${r1(ty)}" class="ns">${esc(line)}</text>`;
  }
  return `${out}</g>`;
}

// ── Timeline / keyframes ─────────────────────────────────────────────────────

function makeTimeline(duration, stepCount) {
  const lead = 0.6;
  const hold = 2.6;
  const fade = 0.7;
  const slot = (duration - lead - hold - fade) / stepCount;
  const draw = Math.min(0.9, slot * 0.68);
  const pct = (t) => r1(Math.min(100, Math.max(0, (t / duration) * 100)));
  const fadeAt = duration - fade;
  const steps = Array.from({ length: stepCount }, (_, i) => {
    const start = lead + i * slot;
    return { start, end: start + draw, slotEnd: start + slot };
  });
  return { duration, slot, draw, steps, fadeAt, pct };
}

/** Shared keyframes per step: stroke draw (d), fade-in (f), arrowhead (h), row highlight (r). */
function stepKeyframes(tl) {
  const { pct, fadeAt } = tl;
  const out = [];
  tl.steps.forEach((s, i) => {
    const f = pct(fadeAt);
    out.push(
      `@keyframes d${i}{0%,${pct(s.start)}%{stroke-dashoffset:105;opacity:1}${pct(s.end)}%,${f}%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}`,
    );
    out.push(
      `@keyframes f${i}{0%,${pct(s.start + 0.1)}%{opacity:0}${pct(s.start + 0.45)}%,${f}%{opacity:1}100%{opacity:0}}`,
    );
    out.push(
      `@keyframes h${i}{0%,${pct(s.end - 0.05)}%{opacity:0}${pct(s.end)}%,${f}%{opacity:1}100%{opacity:0}}`,
    );
    const off = Math.min(s.slotEnd - 0.1, fadeAt);
    out.push(
      `@keyframes r${i}{0%,${pct(s.start - 0.05)}%{opacity:0}${pct(s.start + 0.2)}%,${pct(off)}%{opacity:1}${pct(
        Math.min(off + 0.25, tl.duration),
      )}%,100%{opacity:0}}`,
    );
  });
  return out.join('\n');
}

/** A dot that travels along a polyline during its step (CSS transform keyframes; no motion-path needed). */
function dotKeyframes(name, points, step, tl) {
  const { pct } = tl;
  const total = polylineLength(points) || 1;
  const frames = [
    `0%,${pct(step.start)}%{transform:translate(${r1(points[0][0])}px,${r1(points[0][1])}px);opacity:0}`,
  ];
  frames.push(`${pct(step.start + 0.04)}%{opacity:1}`);
  let acc = 0;
  for (let i = 1; i < points.length; i += 1) {
    acc += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    const t = step.start + (acc / total) * (step.end - step.start);
    frames.push(`${pct(t)}%{transform:translate(${r1(points[i][0])}px,${r1(points[i][1])}px);opacity:1}`);
  }
  frames.push(
    `${pct(step.end + 0.2)}%,100%{transform:translate(${r1(points.at(-1)[0])}px,${r1(points.at(-1)[1])}px);opacity:0}`,
  );
  return `@keyframes ${name}{${frames.join('')}}`;
}

function baseCss(duration) {
  return `
text{font-family:${FONT};fill:${INK}}
.tt{font-size:16px;font-weight:600}
.st{font-size:12px;fill:${MUTED}}
.nt{font-size:12.5px;font-weight:600;text-anchor:middle}
.ns{font-size:10.5px;fill:${MUTED};text-anchor:middle}
.lb{font-size:11.5px;paint-order:stroke;stroke:${BG};stroke-width:4px;stroke-linejoin:round}
.mono{font-family:${MONO}}
.nb{font-size:10px;font-weight:600;text-anchor:middle;fill:${MUTED}}
.ft{font-size:10.5px;fill:${MUTED}}
.base{fill:none;stroke:${FAINT};stroke-width:1.4}
.base.async{stroke-dasharray:5 4}
.ov{fill:none;stroke-width:2.4;stroke-linecap:round;stroke-dasharray:100 110;stroke-dashoffset:0}
.dot{opacity:0}
.row{opacity:0}
.a{animation-duration:${duration}s;animation-iteration-count:infinite;animation-timing-function:ease-in-out;animation-fill-mode:both}
.lin{animation-timing-function:linear}
.so{display:none}
@media (prefers-reduced-motion:reduce){.a{animation:none!important}.dot,.row,.ao{display:none}.so{display:inline}}`;
}

function frame({ width, height, title, subtitle, desc, css, body, footer }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>${css}</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="${BG}" stroke="${FAINT}"/>
<text x="24" y="32" class="tt">${esc(title)}</text>
<text x="24" y="50" class="st">${esc(subtitle)}</text>
${body}
${footer}
</svg>
`;
}

// ── Sequence-style animated flow ─────────────────────────────────────────────

/**
 * Renders a flow whose nodes are lanes (positioned left→right) and whose steps
 * are messages between lanes, one row per message, drawn in order.
 */
function renderSequence(flow) {
  const W = flow.width ?? 1080;
  const padX = 24;
  const gutter = flow.bands?.length ? 54 : 36;
  const headerY = 68;
  const headerH = flow.headerH ?? 50;
  const left = padX + gutter;
  const areaW = W - padX - left;
  const laneW = areaW / flow.lanes.length;
  const laneX = new Map(flow.lanes.map((lane, i) => [lane.id, left + laneW * (i + 0.5)]));
  const boxW = Math.min(laneW - 10, 170);

  // Rows: every edge or note of a step gets its own row.
  let y = headerY + headerH + 16;
  const rows = [];
  flow.steps.forEach((step, si) => {
    for (const item of step.items) {
      const noteLines = item.note ? lines(item.note) : [];
      const h = item.note ? Math.max(32, noteLines.length * 14 + 14) : 34;
      rows.push({ ...item, step: si, top: y, h });
      y += h;
    }
  });
  const lifelineEnd = y + 6;
  const H = lifelineEnd + 64;
  const tl = makeTimeline(flow.duration, flow.steps.length);

  const parts = [];
  const css = [baseCss(flow.duration), stepKeyframes(tl)];

  // Step row highlight (current step) — behind everything else.
  for (const [si] of flow.steps.entries()) {
    const stepRows = rows.filter((row) => row.step === si);
    const top = stepRows[0].top - 2;
    const bottom = stepRows.at(-1).top + stepRows.at(-1).h - 2;
    parts.push(
      `<rect class="row a" style="animation-name:r${si}" x="${padX + gutter - 6}" y="${top}" width="${
        W - padX - left + 6
      }" height="${bottom - top}" rx="6" fill="#f2f6fc"/>`,
    );
  }

  // Phase bands (e.g. "broker unavailable"), static.
  for (const band of flow.bands ?? []) {
    const bandRows = rows.filter((row) => row.step >= band.from && row.step <= band.to);
    const top = bandRows[0].top - 4;
    const bottom = bandRows.at(-1).top + bandRows.at(-1).h;
    const color = TONES[band.tone] ?? TONES.fail;
    parts.push(
      `<rect x="${padX}" y="${top}" width="${W - padX * 2}" height="${bottom - top}" rx="6" fill="${color}" fill-opacity="0.05" stroke="${color}" stroke-opacity="0.35" stroke-dasharray="4 3"/>`,
    );
    const cy = (top + bottom) / 2;
    parts.push(
      `<text transform="translate(${padX + 14} ${cy}) rotate(-90)" class="ft" text-anchor="middle" style="fill:${color};font-weight:600">${esc(
        band.label,
      )}</text>`,
    );
  }

  // Lane headers and lifelines.
  for (const lane of flow.lanes) {
    const cx = laneX.get(lane.id);
    parts.push(
      `<line x1="${r1(cx)}" y1="${headerY + headerH}" x2="${r1(cx)}" y2="${lifelineEnd}" stroke="${FAINT}" stroke-dasharray="3 4"/>`,
    );
    parts.push(
      nodeBox({
        x: cx - boxW / 2,
        y: headerY,
        w: boxW,
        h: headerH,
        title: lane.title,
        sub: lane.sub,
        kind: lane.kind,
      }),
    );
  }

  // Step number badges (always visible so the static frame reads as a numbered list).
  for (const [si] of flow.steps.entries()) {
    const first = rows.find((row) => row.step === si);
    const cy = first.top + (first.note ? first.h / 2 - 1 : 21);
    const bx = padX + gutter - 18;
    parts.push(`<circle cx="${bx}" cy="${cy}" r="8.5" fill="#ffffff" stroke="${FAINT}"/>`);
    parts.push(`<text x="${bx}" y="${cy + 3.5}" class="nb">${si + 1}</text>`);
  }

  // Messages and notes.
  let dotIndex = 0;
  for (const row of rows) {
    const s = row.step;
    const tone = TONES[row.tone ?? 'req'];
    if (row.note) {
      const ids = lines(row.at);
      const xs = ids.map((id) => laneX.get(id));
      const noteLines = lines(row.note);
      const textW = Math.max(...noteLines.map((line) => textWidth(line, 11.5))) + 20;
      const spanW = Math.max(...xs) - Math.min(...xs) + boxW * 0.8;
      const w = Math.max(textW, ids.length > 1 ? spanW : 0);
      const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      const x = Math.min(Math.max(cx - w / 2, left - 4), W - padX - w);
      const h = noteLines.length * 14 + 8;
      const top = row.top + (row.h - h) / 2;
      let g = `<g class="a" style="animation-name:f${s}"><rect x="${r1(x)}" y="${r1(top)}" width="${r1(w)}" height="${h}" rx="5" fill="#ffffff" stroke="${tone}" stroke-width="1.3"/>`;
      noteLines.forEach((line, li) => {
        g += `<text x="${r1(x + w / 2)}" y="${r1(top + 15 + li * 14)}" class="lb" text-anchor="middle">${esc(line)}</text>`;
      });
      parts.push(`${g}</g>`);
      continue;
    }
    const x1 = laneX.get(row.from);
    const x2 = laneX.get(row.to);
    if (x1 === undefined || x2 === undefined)
      throw new Error(`${flow.file}: unknown lane in ${row.from}→${row.to}`);
    const ay = row.top + 25;
    const dir = Math.sign(x2 - x1);
    const pts = [
      [x1 + dir * 3, ay],
      [x2 - dir * 4, ay],
    ];
    const d = `M${r1(pts[0][0])} ${ay}H${r1(pts[1][0])}`;
    const async = row.tone === 'event' || row.tone === 'comp';
    parts.push(
      `<path class="base${async ? ' async' : ''}" d="${d}"/><polygon points="${arrowHead(pts[0], pts[1])}" fill="${FAINT}"/>`,
    );
    parts.push(
      `<path class="ov a" style="animation-name:d${s};stroke:${tone}" d="${d}" pathLength="100"/><polygon class="a" style="animation-name:h${s}" points="${arrowHead(
        pts[0],
        pts[1],
      )}" fill="${tone}"/>`,
    );
    const name = `m${dotIndex++}`;
    css.push(dotKeyframes(name, pts, tl.steps[s], tl));
    parts.push(
      `<circle class="dot a" style="animation-name:${name}" r="4.5" fill="${tone}" stroke="#ffffff" stroke-width="1.5"/>`,
    );
    // Label above the arrow, centred between the lanes and kept inside the canvas.
    const label = row.label ?? '';
    const lw = textWidth(label, 11.5);
    let lx = (x1 + x2) / 2;
    lx = Math.min(Math.max(lx, left + lw / 2), W - padX - 4 - lw / 2);
    parts.push(
      `<text class="lb a${row.mono ? ' mono' : ''}" style="animation-name:f${s}" x="${r1(lx)}" y="${row.top + 18}" text-anchor="middle">${esc(label)}</text>`,
    );
  }

  // Progress bar + footer.
  const barY = H - 50;
  css.push(
    `@keyframes pg{0%{transform:scaleX(0)}${tl.pct(tl.fadeAt)}%{transform:scaleX(1)}100%{transform:scaleX(1)}}`,
  );
  parts.push(
    `<rect class="ao" x="${padX}" y="${barY}" width="${W - padX * 2}" height="3" rx="1.5" fill="#eef1f4"/>`,
  );
  parts.push(
    `<rect class="ao a lin" style="animation-name:pg;transform-box:fill-box;transform-origin:0 50%" x="${padX}" y="${barY}" width="${
      W - padX * 2
    }" height="3" rx="1.5" fill="${TONES.req}" fill-opacity="0.55"/>`,
  );
  const legend = legendMarkup(flow.legend ?? ['req', 'res', 'event'], padX, H - 30);
  const footer = `<text x="${padX}" y="${H - 12}" class="ft"><tspan class="ao">Animated (CSS) · loops every ${flow.duration} s · </tspan><tspan class="so">Reduced motion: all steps shown · </tspan>static Mermaid version: ${esc(
    flow.mermaidPage,
  )}</text>${legend}`;

  return frame({
    width: W,
    height: H,
    title: flow.title,
    subtitle: flow.subtitle,
    desc: flow.desc,
    css: css.join('\n'),
    body: parts.join('\n'),
    footer,
  });
}

const LEGEND_TEXT = {
  req: 'request',
  res: 'response / success',
  event: 'event via RabbitMQ',
  fail: 'failure',
  comp: 'compensation / recovery',
};

function legendMarkup(keys, leftX, y) {
  let x = leftX;
  const out = [];
  for (const key of keys) {
    out.push(
      `<line x1="${r1(x)}" y1="${y - 3.5}" x2="${r1(x + 16)}" y2="${y - 3.5}" stroke="${TONES[key]}" stroke-width="2.4" stroke-linecap="round"/>`,
    );
    x += 22;
    const text = LEGEND_TEXT[key];
    out.push(`<text x="${r1(x)}" y="${y}" class="ft">${esc(text)}</text>`);
    x += textWidth(text, 10.5) + 22;
  }
  return out.join('');
}

// ── Static graph (system overview) ───────────────────────────────────────────

function anchor(node, side, t = 0.5) {
  switch (side) {
    case 'l':
      return [node.x, node.y + node.h * t];
    case 'r':
      return [node.x + node.w, node.y + node.h * t];
    case 't':
      return [node.x + node.w * t, node.y];
    default:
      return [node.x + node.w * t, node.y + node.h];
  }
}

function renderGraph(flow) {
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const parts = [];
  for (const zone of flow.zones ?? []) {
    parts.push(
      `<rect x="${zone.x}" y="${zone.y}" width="${zone.w}" height="${zone.h}" rx="10" fill="${zone.fill ?? '#f6f8fa'}" stroke="${FAINT}" stroke-dasharray="4 3"/>`,
    );
    parts.push(
      `<text x="${zone.x + 10}" y="${zone.y + 16}" class="ft" style="font-weight:600">${esc(zone.label)}</text>`,
    );
  }
  for (const edge of flow.edges) {
    const pts = edge.points.map((p) => (typeof p[0] === 'string' ? anchor(nodes.get(p[0]), p[1], p[2]) : p));
    const d = `M${pts.map((p) => `${r1(p[0])} ${r1(p[1])}`).join('L')}`;
    const color = edge.color ?? '#818b98';
    parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"${edge.dashed ? ' stroke-dasharray="5 4"' : ''}/>`,
    );
    if (edge.head !== false)
      parts.push(`<polygon points="${arrowHead(pts.at(-2), pts.at(-1))}" fill="${color}"/>`);
    if (edge.both) parts.push(`<polygon points="${arrowHead(pts[1], pts[0])}" fill="${color}"/>`);
    if (edge.label) {
      const [lx, ly] = edge.lp;
      parts.push(
        `<text x="${lx}" y="${ly}" class="lb" text-anchor="${edge.anchor ?? 'middle'}" style="font-size:10.5px;fill:${MUTED}">${esc(edge.label)}</text>`,
      );
    }
  }
  for (const node of flow.nodes) parts.push(nodeBox(node));
  const footer = `<text x="24" y="${flow.height - 14}" class="ft">${esc(flow.footer)}</text>`;
  return frame({
    width: flow.width,
    height: flow.height,
    title: flow.title,
    subtitle: flow.subtitle,
    desc: flow.desc,
    css: baseCss(1),
    body: parts.join('\n'),
    footer,
  });
}

// ── Flow declarations ────────────────────────────────────────────────────────

const msg = (from, to, label, tone = 'req', extra = {}) => ({ from, to, label, tone, ...extra });
const note = (at, text, tone = 'note') => ({ at, note: text, tone });
const step = (...items) => ({ items });

const FLOWS = [
  {
    file: 'request-lifecycle.svg',
    mermaidPage: 'docs/architecture/02-request-lifecycle.md',
    title: 'Request lifecycle: client → gateway → service',
    subtitle: 'POST /api/v1/orders through the API gateway (apps/api-gateway) into order-service',
    desc: 'Animated sequence. 1 client sends POST /api/v1/orders with a bearer token and Idempotency-Key. 2 the gateway normalises the path, assigns x-request-id and x-correlation-id and starts a server span. 3-4 it checks the Redis-backed rate limit (fail-open). 5 it proxies to order-service with a 10 second timeout and a per-upstream circuit breaker; the fetch instrumentation injects traceparent. 6-7 order-service verifies the ES256 access token against the cached JWKS of auth-service. 8-9 it snapshots prices from product-service over the internal API. 10 it commits the order, saga state and outbox row in one transaction. 11-12 the response, or an application/problem+json error, flows back with X-Request-Id.',
    duration: 14,
    lanes: [
      { id: 'client', title: 'Client', sub: 'browser / API', kind: 'client' },
      { id: 'gw', title: 'api-gateway', sub: ':8080', kind: 'gateway' },
      { id: 'redis', title: 'Redis', sub: 'rate-limit store', kind: 'cache' },
      { id: 'order', title: 'order-service', sub: ':3005', kind: 'service' },
      { id: 'auth', title: 'auth-service', sub: 'JWKS', kind: 'service' },
      { id: 'product', title: 'product-service', sub: 'internal API', kind: 'service' },
      { id: 'db', title: 'orders_db', sub: 'PostgreSQL', kind: 'data' },
    ],
    steps: [
      step(msg('client', 'gw', 'POST /api/v1/orders · Bearer JWT · Idempotency-Key')),
      step(
        note('gw', [
          'normalise path (reject .. and encoded separators)',
          'set x-request-id / x-correlation-id · start span',
        ]),
      ),
      step(msg('gw', 'redis', 'rate limit 300/min/IP (20 on auth routes)')),
      step(msg('redis', 'gw', 'under limit → continue (else 429; fail-open)', 'res')),
      step(msg('gw', 'order', 'proxy: traceparent + x-request-id · 10 s timeout · breaker')),
      step(msg('order', 'auth', 'GET /.well-known/jwks.json (cached)')),
      step(note('order', ['verify ES256 token locally', 'iss · aud · exp · typ at+jwt'])),
      step(msg('order', 'product', 'GET /internal/v1/products · 2 s timeout · breaker')),
      step(msg('product', 'order', 'price snapshot', 'res')),
      step(msg('order', 'db', 'one tx: order PENDING + saga + outbox row')),
      step(msg('order', 'gw', '201 Created (errors → application/problem+json)', 'res')),
      step(msg('gw', 'client', '201 + X-Request-Id (upstream down → 502/503/504 problem+json)', 'res')),
    ],
    legend: ['req', 'res'],
  },
  {
    file: 'order-saga-success.svg',
    mermaidPage: 'docs/architecture/04-order-saga.md',
    title: 'Order saga — happy path',
    subtitle:
      'order-service orchestrates; every event is written to the outbox and travels via domain.events',
    desc: 'Animated sequence of the orchestrated order saga. The client creates an order (status PENDING). order-service publishes OrderCreated; inventory-service reserves stock and publishes InventoryReserved; order-service moves to AWAITING_PAYMENT and publishes PaymentAuthorizationRequested; payment-service authorises with the simulator and publishes PaymentAuthorized; order-service confirms the order and publishes OrderConfirmed, which makes inventory commit the reservation, payment capture the funds and notification-service send the confirmation email.',
    duration: 14,
    lanes: [
      { id: 'client', title: 'Client', sub: 'via api-gateway', kind: 'client' },
      { id: 'order', title: 'order-service', sub: 'saga orchestrator', kind: 'service' },
      { id: 'mq', title: 'RabbitMQ', sub: 'domain.events', kind: 'broker' },
      { id: 'inv', title: 'inventory-service', sub: 'reservations', kind: 'service' },
      { id: 'pay', title: 'payment-service', sub: 'simulator', kind: 'service' },
      { id: 'notif', title: 'notification-service', sub: 'email', kind: 'service' },
    ],
    steps: [
      step(msg('client', 'order', 'POST /orders (Idempotency-Key)')),
      step(msg('order', 'client', '201 · PENDING · saga AWAITING_INVENTORY', 'res')),
      step(msg('order', 'mq', 'OrderCreated · order.created.v1', 'event', { mono: false })),
      step(msg('mq', 'inv', 'reserve all lines atomically → RESERVED', 'event')),
      step(msg('inv', 'mq', 'InventoryReserved · inventory.reserved.v1', 'event')),
      step(msg('mq', 'order', 'order → AWAITING_PAYMENT', 'event')),
      step(msg('order', 'mq', 'PaymentAuthorizationRequested', 'event')),
      step(msg('mq', 'pay', 'authorize (one payment per order)', 'event')),
      step(msg('pay', 'mq', 'PaymentAuthorized · payment.authorized.v1', 'event')),
      step(msg('mq', 'order', 'order → CONFIRMED · saga COMPLETED', 'res')),
      step(msg('order', 'mq', 'OrderConfirmed · order.confirmed.v1', 'event')),
      step(
        msg('mq', 'inv', 'commit reservation → InventoryCommitted', 'res'),
        msg('mq', 'pay', 'capture → PaymentCaptured', 'res'),
        msg('mq', 'notif', 'send order-confirmed email', 'res'),
      ),
    ],
    legend: ['req', 'res', 'event'],
  },
  {
    file: 'order-saga-compensation.svg',
    mermaidPage: 'docs/architecture/04-order-saga.md',
    title: 'Order saga — payment declined and compensation',
    subtitle: 'paymentMethodToken sim_card_declined → PaymentFailed → OrderCancelled fan-out',
    desc: 'Animated sequence of the compensation path. Stock is reserved, then the payment simulator declines the card. payment-service publishes PaymentFailed; order-service cancels the order (reason payment_failed, saga COMPENSATED) and publishes OrderCancelled. inventory-service releases the reservation (InventoryReleased); payment-service checks its compensation table — a FAILED payment has nothing to void (an AUTHORIZED one would be voided, a CAPTURED one refunded); notification-service emails the customer.',
    duration: 14,
    lanes: [
      { id: 'client', title: 'Client', sub: 'via api-gateway', kind: 'client' },
      { id: 'order', title: 'order-service', sub: 'saga orchestrator', kind: 'service' },
      { id: 'mq', title: 'RabbitMQ', sub: 'domain.events', kind: 'broker' },
      { id: 'inv', title: 'inventory-service', sub: 'reservations', kind: 'service' },
      { id: 'pay', title: 'payment-service', sub: 'simulator', kind: 'service' },
      { id: 'notif', title: 'notification-service', sub: 'email', kind: 'service' },
    ],
    steps: [
      step(msg('client', 'order', 'POST /orders · sim_card_declined')),
      step(msg('order', 'mq', 'OrderCreated', 'event')),
      step(msg('mq', 'inv', 'reserve stock → RESERVED', 'event')),
      step(msg('inv', 'mq', 'InventoryReserved', 'event')),
      step(msg('mq', 'order', 'order → AWAITING_PAYMENT', 'event')),
      step(msg('order', 'mq', 'PaymentAuthorizationRequested', 'event')),
      step(msg('mq', 'pay', 'simulator declines → payment FAILED', 'fail')),
      step(msg('pay', 'mq', 'PaymentFailed · payment.failed.v1', 'fail')),
      step(msg('mq', 'order', 'order → CANCELLED (payment_failed) · saga COMPENSATED', 'fail')),
      step(msg('order', 'mq', 'OrderCancelled · order.cancelled.v1', 'comp')),
      step(
        msg('mq', 'inv', 'release reservation → InventoryReleased', 'comp'),
        msg('mq', 'pay', 'FAILED: nothing to void (AUTHORIZED → void)', 'comp'),
        msg('mq', 'notif', 'send order-cancelled email', 'comp'),
      ),
    ],
    legend: ['req', 'event', 'fail', 'comp'],
  },
  {
    file: 'transactional-outbox.svg',
    mermaidPage: 'docs/architecture/05-transactional-outbox.md',
    title: 'Transactional outbox',
    subtitle: 'packages/database (enqueueEvent, claimOutboxBatch) + packages/messaging (OutboxRelay)',
    desc: 'Animated sequence. A request handler changes business state and inserts the event into outbox_events in the same transaction, then commits. After commit it nudges the relay (otherwise the relay polls every 500 ms). The relay claims rows with UPDATE … FOR UPDATE SKIP LOCKED, setting PUBLISHING with a 30 second lease, publishes each to RabbitMQ on a confirm channel and marks it PUBLISHED after the broker confirm. Consumers de-duplicate by message id in processed_messages. Failed publishes return the row to PENDING with exponential backoff (max 60 s); rows are never dropped.',
    duration: 13,
    lanes: [
      { id: 'handler', title: 'Service handler', sub: 'HTTP or consumer', kind: 'service' },
      { id: 'db', title: 'Service DB', sub: 'outbox_events', kind: 'data' },
      { id: 'relay', title: 'OutboxRelay', sub: 'same process', kind: 'worker' },
      { id: 'mq', title: 'RabbitMQ', sub: 'domain.events', kind: 'broker' },
      { id: 'consumer', title: 'Consumer', sub: 'another service', kind: 'service' },
    ],
    steps: [
      step(msg('handler', 'db', 'BEGIN · business change')),
      step(msg('handler', 'db', 'enqueueEvent(tx): validate, INSERT PENDING + traceparent')),
      step(msg('handler', 'db', 'COMMIT — state and event together or not at all', 'res')),
      step(msg('handler', 'relay', 'notify() after commit (else 500 ms poll)')),
      step(msg('relay', 'db', 'claim batch: FOR UPDATE SKIP LOCKED → PUBLISHING, lease 30 s')),
      step(msg('relay', 'mq', 'publish persistent message (confirm channel)', 'event')),
      step(msg('mq', 'relay', 'broker confirm', 'res')),
      step(msg('relay', 'db', 'mark PUBLISHED', 'res')),
      step(msg('mq', 'consumer', 'deliver to <service>.events', 'event')),
      step(note('consumer', ['processed_messages insert in handler tx', 'duplicate id → no-op · then ack'])),
      step(
        note(
          ['db', 'relay'],
          [
            'publish failed? row → PENDING, backoff ≤ 60 s, attempts + 1',
            'crashed relay? lease expires and the row is claimed again',
          ],
          'comp',
        ),
      ),
    ],
    legend: ['req', 'res', 'event', 'comp'],
  },
  {
    file: 'retry-dead-letter.svg',
    mermaidPage: 'docs/architecture/06-retry-dead-letter.md',
    title: 'Retry tiers, dead-lettering and replay',
    subtitle:
      'packages/messaging consumer · apps/worker dead-letter archive · topology from packages/contracts/src/topology.ts',
    desc: 'Animated sequence. A consumer handler fails on a transient error; the consumer copies the message to <queue>.retry.1 (TTL 1 s), acks the original, and the TTL dead-letters it back to the main queue through the default exchange. The same happens through retry.2 (5 s) and retry.3 (15 s). When retries are exhausted the consumer publishes the message to the dead-letters exchange with diagnostic headers; worker.dead-letters (bound with #) archives it in the dead_letters table. An operator replays it through the worker admin API, which republishes to the original queue. Poison messages skip the retry tiers.',
    duration: 14,
    bands: [],
    lanes: [
      { id: 'q', title: '<svc>.events', sub: 'quorum queue', kind: 'broker' },
      { id: 'c', title: 'Consumer', sub: 'manual ack', kind: 'service' },
      { id: 'r1', title: 'retry.1', sub: 'TTL 1 s', kind: 'broker' },
      { id: 'r2', title: 'retry.2', sub: 'TTL 5 s', kind: 'broker' },
      { id: 'r3', title: 'retry.3', sub: 'TTL 15 s', kind: 'broker' },
      { id: 'dlx', title: 'dead-letters', sub: 'topic exchange', kind: 'broker' },
      { id: 'w', title: 'worker', sub: 'archive · dead_letters', kind: 'worker' },
      { id: 'op', title: 'Operator', sub: 'admin API :3009', kind: 'client' },
    ],
    steps: [
      step(msg('q', 'c', 'deliver (x-retry-attempt 0)', 'event')),
      step(msg('c', 'r1', 'handler threw → copy attempt=1, ack original', 'fail')),
      step(msg('r1', 'q', 'TTL expires → back via default exchange', 'comp')),
      step(msg('q', 'c', 'redeliver · fails again', 'fail')),
      step(msg('c', 'r2', 'copy attempt=2, ack', 'fail')),
      step(msg('r2', 'q', 'TTL 5 s → back to queue', 'comp')),
      step(msg('c', 'r3', 'attempt 2 fails → copy attempt=3, ack', 'fail')),
      step(msg('r3', 'q', 'TTL 15 s → back to queue', 'comp')),
      step(msg('q', 'c', 'attempt 3 fails → retries exhausted', 'fail')),
      step(msg('c', 'dlx', 'publish with x-dead-letter-reason, x-original-queue, ack', 'fail')),
      step(msg('dlx', 'w', "worker.dead-letters ('#') → upsert row, occurrences + 1", 'event')),
      step(msg('op', 'w', 'POST /admin/v1/dead-letters/:id/replay')),
      step(msg('w', 'q', 'republish to original queue (default exchange) · REPLAYED', 'res')),
      step(
        note(
          ['q', 'r3'],
          [
            'poison (invalid_message, unhandled_event_type) or NonRetryableError → dead-letters at once',
            'crash loop → quorum x-delivery-limit 10 dead-letters natively',
          ],
          'fail',
        ),
      ),
    ],
    legend: ['req', 'res', 'event', 'fail', 'comp'],
  },
  {
    file: 'failure-recovery.svg',
    mermaidPage: 'docs/architecture/12-failure-recovery.md',
    title: 'Failure recovery — RabbitMQ outage',
    subtitle: 'events wait in the outbox while the broker is down; amqplib reconnects and the backlog drains',
    desc: 'Animated sequence. The broker connection drops: messaging_connection_up becomes 0 and readiness reports 503 because RabbitMQ is a critical check. Requests that still reach order-service commit the order and its OrderCreated row to the outbox in one transaction. The relay skips cycles while disconnected, so rows stay PENDING. amqplib retries the connection with exponential backoff; on reconnect the registered setup functions re-assert topology and re-subscribe consumers. The relay then claims and publishes the backlog with confirms and marks rows PUBLISHED; the broker redelivers anything that was unacked and idempotent consumers ignore duplicates.',
    duration: 14,
    bands: [{ from: 0, to: 5, label: 'RabbitMQ unavailable', tone: 'fail' }],
    lanes: [
      { id: 'client', title: 'Client', sub: 'via api-gateway', kind: 'client' },
      { id: 'order', title: 'order-service', sub: 'HTTP handlers', kind: 'service' },
      { id: 'db', title: 'orders_db', sub: 'outbox_events', kind: 'data' },
      { id: 'relay', title: 'OutboxRelay', sub: '+ AMQP client', kind: 'worker' },
      { id: 'mq', title: 'RabbitMQ', sub: 'broker', kind: 'broker' },
      { id: 'cons', title: 'Consumers', sub: 'inventory, audit, …', kind: 'service' },
    ],
    steps: [
      step(msg('mq', 'relay', 'connection lost', 'fail')),
      step(
        note('relay', ['messaging_connection_up = 0 · readiness 503', 'BrokerConnectionLost alert'], 'fail'),
      ),
      step(msg('client', 'order', 'POST /orders (request reaches the service)')),
      step(msg('order', 'db', 'one tx: order + OrderCreated row (PENDING)', 'res')),
      step(
        note('relay', [
          'relay skips cycles while disconnected',
          'outbox_pending_events grows; nothing is lost',
        ]),
      ),
      step(msg('relay', 'mq', 'reconnect with exponential backoff …', 'fail')),
      step(msg('mq', 'relay', 'connected → re-assert topology, re-subscribe consumers', 'comp')),
      step(msg('relay', 'db', 'claim backlog (SKIP LOCKED, lease 30 s)', 'comp')),
      step(msg('relay', 'mq', 'publish backlog with confirms', 'event')),
      step(msg('relay', 'db', 'mark rows PUBLISHED', 'res')),
      step(msg('mq', 'cons', 'deliver; unacked messages are redelivered', 'event')),
      step(note('cons', ['processed_messages: duplicates are no-ops'])),
    ],
    legend: ['req', 'res', 'event', 'fail', 'comp'],
  },
  {
    file: 'auth-refresh-rotation.svg',
    mermaidPage: 'docs/architecture/07-authentication.md',
    title: 'Refresh-token rotation with reuse detection',
    subtitle:
      'apps/auth-service — opaque 256-bit refresh tokens stored as SHA-256 hashes, one family per session',
    desc: 'Animated sequence. Login verifies the Argon2id hash, opens a token family and returns a 15 minute ES256 access token plus refresh token R1 in an HttpOnly cookie. Refreshing with R1 revokes R1 (rotated) and issues R2 in the same family. When a stolen copy of R1 is presented again, auth-service detects reuse, revokes the whole family, publishes RefreshTokenReuseDetected through the outbox and answers 401; the legitimate client must log in again because R2 was revoked too.',
    duration: 13,
    lanes: [
      { id: 'client', title: 'Client', sub: 'legitimate user', kind: 'client' },
      { id: 'thief', title: 'Stolen copy', sub: 'replays old token', kind: 'actor' },
      { id: 'auth', title: 'auth-service', sub: 'via api-gateway', kind: 'service' },
      { id: 'db', title: 'auth_db', sub: 'refresh_tokens', kind: 'data' },
      { id: 'mq', title: 'RabbitMQ', sub: 'domain.events', kind: 'broker' },
    ],
    steps: [
      step(msg('client', 'auth', 'POST /api/v1/auth/login')),
      step(msg('auth', 'db', 'Argon2id verify · new family F · store SHA-256(R1)')),
      step(msg('auth', 'client', 'access JWT (ES256, 15 min) + R1 cookie (HttpOnly)', 'res')),
      step(msg('client', 'auth', 'POST /api/v1/auth/refresh with R1')),
      step(msg('auth', 'db', 'revoke R1 (rotated) · insert R2 in family F')),
      step(msg('auth', 'client', 'new access JWT + R2', 'res')),
      step(msg('thief', 'auth', 'POST /api/v1/auth/refresh with copied R1', 'fail')),
      step(msg('auth', 'db', 'R1 already revoked → revoke family F (reuse_detected)', 'fail')),
      step(msg('auth', 'mq', 'RefreshTokenReuseDetected (outbox) → audit', 'event')),
      step(msg('auth', 'thief', '401 application/problem+json', 'fail')),
      step(msg('client', 'auth', 'refresh with R2 → 401: session revoked, log in again', 'fail')),
    ],
    legend: ['req', 'res', 'event', 'fail'],
  },
];

// System overview: static (no animation) hero image for the README.
const OVERVIEW = (() => {
  const svcW = 150;
  const svcH = 50;
  const gridX = 410;
  const col = (i) => gridX + i * (svcW + 14);
  const row = (i) => 116 + i * (svcH + 12);
  const services = [
    ['auth', 'auth-service', ':3001 · auth_db'],
    ['user', 'user-service', ':3002 · users_db'],
    ['product', 'product-service', ':3003 · product_db'],
    ['inventory', 'inventory-service', ':3004 · inventory_db'],
    ['order', 'order-service', ':3005 · orders_db'],
    ['payment', 'payment-service', ':3006 · payment_db'],
    ['worker', 'worker', ':3009 · scheduler · DLQ'],
    ['audit', 'audit-service', ':3008 · audit_db'],
    ['notification', 'notification-service', ':3007 · notification_db'],
  ].map(([id, title, sub], i) => ({
    id,
    title,
    sub,
    kind: id === 'worker' ? 'worker' : 'service',
    x: col(i % 3),
    y: row(Math.floor(i / 3)),
    w: svcW,
    h: svcH,
  }));
  const gridRight = col(2) + svcW; // 888
  const obsW = (gridRight - gridX - 3 * 14) / 4;
  const obs = [
    ['jaeger', 'Jaeger', 'traces · UI :16686'],
    ['loki', 'Loki', 'logs via OTLP'],
    ['prom', 'Prometheus', 'scrapes /metrics · :9090'],
    ['grafana', 'Grafana', 'dashboards · :3000'],
  ].map(([id, title, sub], i) => ({
    id,
    title,
    sub,
    kind: 'obs',
    x: gridX + i * (obsW + 14),
    y: 456,
    w: obsW,
    h: 50,
  }));
  const nodes = [
    {
      id: 'client',
      title: 'Clients',
      sub: ['browser · mobile · API'],
      kind: 'client',
      x: 24,
      y: 172,
      w: 128,
      h: 60,
    },
    {
      id: 'gw',
      title: 'api-gateway',
      sub: ['rate limit · proxy', 'breaker · Swagger /docs'],
      kind: 'gateway',
      x: 222,
      y: 166,
      w: 144,
      h: 72,
    },
    {
      id: 'redis',
      title: 'Redis 8',
      sub: ['rate limits · cache', 'scheduler lock'],
      kind: 'cache',
      x: 222,
      y: 330,
      w: 144,
      h: 60,
    },
    ...services,
    {
      id: 'mailpit',
      title: 'Mailpit',
      sub: ['SMTP · UI :8025'],
      kind: 'client',
      x: 924,
      y: row(2),
      w: 132,
      h: 50,
    },
    {
      id: 'mq',
      title: 'RabbitMQ 4.1',
      sub: ['domain.events · maintenance.commands', 'dead-letters · quorum queues + retry tiers'],
      kind: 'broker',
      x: gridX,
      y: 330,
      w: 232,
      h: 66,
    },
    {
      id: 'pg',
      title: 'PostgreSQL 17',
      sub: ['one database + role per service', 'outbox_events · processed_messages'],
      kind: 'data',
      x: gridRight - 232,
      y: 330,
      w: 232,
      h: 66,
    },
    ...obs,
  ];
  const svcZone = {
    x: gridX - 14,
    y: 92,
    w: gridRight - gridX + 28,
    h: 214,
    label: 'Express + TypeScript services (OpenTelemetry SDK in each)',
    fill: '#f6fef8',
  };
  return {
    file: 'system-overview.svg',
    width: 1080,
    height: 590,
    title: 'Express Microservices Blueprint — system overview',
    subtitle: 'Static diagram (no animation). Mermaid version: docs/architecture/01-system-overview.md',
    desc: 'Static system overview. Clients reach only the api-gateway on port 8080, which uses Redis for rate limits and proxies to eight Express services. Each service owns one PostgreSQL database, publishes events through a transactional outbox and consumes them from RabbitMQ (exchanges domain.events, maintenance.commands and dead-letters). The worker schedules maintenance commands and archives dead letters. notification-service sends email through Mailpit. Every service exports traces to Jaeger and logs to Loki through OpenTelemetry; Prometheus scrapes metrics and Grafana shows dashboards.',
    footer:
      'Static overview · solid = synchronous HTTP / SQL · dashed = asynchronous AMQP or telemetry · only :8080 serves the public API; every published port binds to 127.0.0.1',
    zones: [
      {
        x: 204,
        y: 66,
        w: 864,
        h: 468,
        label: 'docker compose project "emb" — private network',
        fill: '#ffffff',
      },
      svcZone,
      { x: gridX - 14, y: 424, w: gridRight - gridX + 28, h: 96, label: 'Observability', fill: '#fffaf5' },
    ],
    nodes,
    edges: [
      {
        points: [
          ['client', 'r'],
          ['gw', 'l'],
        ],
        label: 'HTTP :8080',
        lp: [187, 196],
        color: TONES.req,
      },
      {
        points: [
          ['gw', 'r', 0.5],
          [svcZone.x, 202],
        ],
        color: TONES.req,
      },
      {
        points: [
          ['gw', 'b', 0.35],
          ['redis', 't', 0.35],
        ],
        color: '#818b98',
        label: 'rate limits',
        lp: [278, 288],
        anchor: 'start',
      },
      {
        points: [
          [svcZone.x, 262],
          [340, 262],
          [340, 330],
        ],
        color: '#818b98',
        label: 'cache · locks',
        lp: [346, 318],
        anchor: 'start',
      },
      {
        points: [
          [col(0) + 60, svcZone.y + svcZone.h],
          [col(0) + 60, 330],
        ],
        color: TONES.event,
        dashed: true,
        both: true,
        label: 'AMQP (outbox → publish, consume)',
        lp: [col(0) + 68, 322],
        anchor: 'start',
      },
      {
        points: [
          [gridRight - 60, svcZone.y + svcZone.h],
          [gridRight - 60, 330],
        ],
        color: '#818b98',
        label: 'SQL (own DB only)',
        lp: [gridRight - 68, 322],
        anchor: 'end',
      },
      {
        points: [
          ['notification', 'r'],
          ['mailpit', 'l'],
        ],
        color: '#818b98',
        label: 'SMTP',
        lp: [906, row(2) + svcH / 2 - 6],
      },
      {
        points: [
          [svcZone.x + svcZone.w, 290],
          [914, 290],
          [914, 472],
          [svcZone.x + svcZone.w, 472],
        ],
        color: TONES.comp,
        dashed: true,
        label: 'OTLP traces + logs',
        lp: [922, 420],
        anchor: 'start',
      },
      {
        points: [
          [914, 472],
          [914, 472],
        ],
        head: false,
        label: '/metrics scrapes',
        lp: [922, 436],
        anchor: 'start',
        color: TONES.comp,
      },
    ],
  };
})();

// ── Build ────────────────────────────────────────────────────────────────────

function validate(svg, file) {
  if (/<script/i.test(svg)) throw new Error(`${file}: contains <script>`);
  if (/(?:href|url\()\s*=?\s*["']?\s*https?:/i.test(svg))
    throw new Error(`${file}: references a remote resource`);
  if (/@import|<image|<foreignObject/i.test(svg)) throw new Error(`${file}: contains a disallowed element`);
  const bytes = Buffer.byteLength(svg);
  if (bytes > MAX_BYTES) throw new Error(`${file}: ${bytes} bytes exceeds ${MAX_BYTES}`);
  return bytes;
}

mkdirSync(OUT_DIR, { recursive: true });
const outputs = [
  ...FLOWS.map((flow) => [flow.file, renderSequence(flow)]),
  [OVERVIEW.file, renderGraph(OVERVIEW)],
];
for (const [file, svg] of outputs) {
  const bytes = validate(svg, file);
  const target = join(OUT_DIR, file);
  writeFileSync(target, svg);
  console.log(`${relative(ROOT, target).padEnd(48)} ${(bytes / 1024).toFixed(1).padStart(5)} KB`);
}
