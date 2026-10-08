import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { CharacterInfo } from './story-analysis';
import type { Relation } from './types';

export interface GraphNode extends SimulationNodeDatum { id: string; info: CharacterInfo; r: number }

export const nodeRadius = (info: CharacterInfo, max: number) => 15 + Math.sqrt(info.lines / Math.max(1, max)) * 19 + Math.min(info.scenes.length, 6);

export const relationPairKey = (a: string, b: string) => [a, b].sort((left, right) => left.localeCompare(right)).join('\\u0000');

export type Point = { x: number; y: number };

/** Relation labels wrap to at most two short lines (the full text stays in the tooltip). */
export const LABEL_LINE_CHARS = 12;
export function labelLines(text: string): string[] {
  const chars = Array.from(text.trim());
  if (chars.length <= LABEL_LINE_CHARS) return [chars.join('')];
  // Prefer breaking right after punctuation near the middle of the first line's room.
  const breakAfter = new Set(['；', '，', '、', '。', '：', ';', ',', ' ', '）', ')']);
  let cut = LABEL_LINE_CHARS;
  for (let i = LABEL_LINE_CHARS; i >= Math.ceil(LABEL_LINE_CHARS / 2); i -= 1) if (breakAfter.has(chars[i - 1])) { cut = i; break; }
  const first = chars.slice(0, cut).join('').trim();
  const rest = chars.slice(cut).join('').trim().replace(/^[；，、。：;,]+/, '');
  const second = Array.from(rest).length > LABEL_LINE_CHARS ? `${Array.from(rest).slice(0, LABEL_LINE_CHARS - 1).join('')}…` : rest;
  return second ? [first, second] : [first];
}
export const LABEL_LINE_HEIGHT = 17;
export const LABEL_STACK_GAP = 6;
export const labelSize = (text: string) => {
  const lines = labelLines(text);
  return { lines, width: Math.max(...lines.map((line) => Array.from(line).length)) * 14 + 24, height: 22 + (lines.length - 1) * (LABEL_LINE_HEIGHT + 4) };
};
export type CoLink = { a: string; b: string; weight: number };

const positionsKey = (projectId: string) => `sf:relation-pos:${projectId}`;
export function loadPositions(projectId: string): Map<string, Point> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(positionsKey(projectId)) ?? '{}') as Record<string, Point>;
    return new Map(Object.entries(raw).filter(([, point]) => Number.isFinite(point?.x) && Number.isFinite(point?.y)));
  } catch { return new Map(); }
}
export function savePositions(projectId: string, positions: Map<string, Point>) {
  try { window.localStorage.setItem(positionsKey(projectId), JSON.stringify(Object.fromEntries(positions))); } catch { /* optional */ }
}

/**
 * Seed order for the initial circle: walk confirmed relations first (strongest bond first), then
 * shared scenes, so related characters start next to each other and the simulation does not have
 * to untangle crossings it created itself.
 */
function seedOrder(characters: CharacterInfo[], links: CoLink[], relations: Relation[]) {
  const names = characters.map((info) => info.name);
  const known = new Set(names);
  const weight = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, value: number) => {
    if (!known.has(a) || !known.has(b) || a === b) return;
    for (const [from, to] of [[a, b], [b, a]]) {
      const row = weight.get(from) ?? new Map<string, number>();
      row.set(to, (row.get(to) ?? 0) + value);
      weight.set(from, row);
    }
  };
  relations.forEach((relation) => add(relation.from, relation.to, 100));
  links.forEach((link) => add(link.a, link.b, Math.min(link.weight, 10)));
  const lines = new Map(characters.map((info) => [info.name, info.lines]));
  const order: string[] = [];
  const placed = new Set<string>();
  while (placed.size < names.length) {
    const root = names.filter((name) => !placed.has(name)).sort((a, b) => (lines.get(b) ?? 0) - (lines.get(a) ?? 0))[0];
    const queue = [root];
    placed.add(root);
    while (queue.length) {
      const current = queue.shift()!;
      order.push(current);
      const next = [...(weight.get(current) ?? new Map<string, number>()).entries()].filter(([name]) => !placed.has(name)).sort((a, b) => b[1] - a[1]);
      for (const [name] of next) { placed.add(name); queue.push(name); }
    }
  }
  return order;
}

type Box = { x0: number; x1: number; y0: number; y1: number };
type SimNode = SimulationNodeDatum & { id: string; r: number; hx: number; up: number; down: number };
/** A relation label always sits on the middle of its line, so it is moved by moving the two characters. */
type LabelBody = { a: SimNode; b: SimNode; hx: number; half: number };
type SimLink = SimulationLinkDatum<SimNode> & { gap: number; pull: number };

const boxOf = (node: SimNode): Box => ({ x0: (node.x ?? 0) - node.hx, x1: (node.x ?? 0) + node.hx, y0: (node.y ?? 0) - node.up, y1: (node.y ?? 0) + node.down });
const labelBox = (label: LabelBody): Box => {
  const x = ((label.a.x ?? 0) + (label.b.x ?? 0)) / 2, y = ((label.a.y ?? 0) + (label.b.y ?? 0)) / 2;
  return { x0: x - label.hx, x1: x + label.hx, y0: y - label.half, y1: y + label.half };
};
const overlaps = (p: Box, q: Box) => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;

/** Rectangle collision: characters (circle + name underneath) and relation labels never cover each other. */
function rectCollide(bodies: SimNode[], labels: LabelBody[]) {
  type Item = { box: () => Box; movers: SimNode[] };
  const items: Item[] = [
    ...bodies.map((body) => ({ box: () => boxOf(body), movers: [body] })),
    ...labels.map((label) => ({ box: () => labelBox(label), movers: [label.a, label.b] })),
  ];
  const push = (movers: SimNode[], dx: number, dy: number) => {
    const free = movers.filter((node) => node.fx == null);
    free.forEach((node) => { node.vx = (node.vx ?? 0) + dx / free.length; node.vy = (node.vy ?? 0) + dy / free.length; });
  };
  return (alpha: number) => {
    const strength = 0.25 + alpha * 0.75;
    for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) {
      const p = items[i].box(), q = items[j].box();
      const ox = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      const oy = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
      if (ox <= 0 || oy <= 0) continue;
      // A label overlapping one of its own two characters means the line is too short: lengthen it.
      const shared = items[i].movers.filter((node) => items[j].movers.includes(node));
      const ownCharacter = shared.length > 0 && (items[i].movers.length === 1 || items[j].movers.length === 1);
      if (ownCharacter) {
        const label = items[i].movers.length === 2 ? items[i].movers : items[j].movers;
        {
          const [a, b] = label;
          const dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0);
          const length = Math.hypot(dx, dy) || 1;
          const amount = Math.min(ox, oy) * strength * 0.5;
          if (a.fx == null) { a.vx = (a.vx ?? 0) - (dx / length) * amount; a.vy = (a.vy ?? 0) - (dy / length) * amount; }
          if (b.fx == null) { b.vx = (b.vx ?? 0) + (dx / length) * amount; b.vy = (b.vy ?? 0) + (dy / length) * amount; }
        }
        continue;
      }
      // Two labels on lines from the same character: fan the far ends apart instead of moving the shared one.
      const iMovers = items[i].movers.filter((node) => !shared.includes(node));
      const jMovers = items[j].movers.filter((node) => !shared.includes(node));
      const iFree = iMovers.some((node) => node.fx == null), jFree = jMovers.some((node) => node.fx == null);
      if (!iFree && !jFree) continue;
      const share = !iFree ? 0 : !jFree ? 1 : 0.5;
      if (ox < oy) {
        const dir = (p.x0 + p.x1) / 2 < (q.x0 + q.x1) / 2 ? -1 : 1;
        push(iMovers, dir * ox * strength * share, 0);
        push(jMovers, -dir * ox * strength * (1 - share), 0);
      } else {
        const dir = (p.y0 + p.y1) / 2 < (q.y0 + q.y1) / 2 ? -1 : 1;
        push(iMovers, 0, dir * oy * strength * share);
        push(jMovers, 0, -dir * oy * strength * (1 - share));
      }
    }
  };
}

function crossings(segments: [SimNode, SimNode][]) {
  const ccw = (a: SimNode, b: SimNode, c: SimNode) => ((c.y ?? 0) - (a.y ?? 0)) * ((b.x ?? 0) - (a.x ?? 0)) > ((b.y ?? 0) - (a.y ?? 0)) * ((c.x ?? 0) - (a.x ?? 0));
  let count = 0;
  for (let i = 0; i < segments.length; i += 1) for (let j = i + 1; j < segments.length; j += 1) {
    const [a, b] = segments[i], [c, d] = segments[j];
    if (a === c || a === d || b === c || b === d) continue;
    if (ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d)) count += 1;
  }
  return count;
}

/**
 * Stress layout: every pair of characters tries to sit at its distance in the relation graph
 * (sum of line lengths along the shortest chain of relations). Small story graphs come out
 * untangled and grouped by who is actually related, instead of by who merely shares scenes.
 */
function stressLayout(order: string[], edges: { a: string; b: string; length: number }[], start: Map<string, Point>) {
  const n = order.length;
  const index = new Map(order.map((name, i) => [name, i]));
  const dist: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)));
  edges.forEach(({ a, b, length }) => {
    const i = index.get(a), j = index.get(b);
    if (i === undefined || j === undefined) return;
    dist[i][j] = Math.min(dist[i][j], length);
    dist[j][i] = dist[i][j];
  });
  for (let k = 0; k < n; k += 1) for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
    if (dist[i][k] + dist[k][j] < dist[i][j]) dist[i][j] = dist[i][k] + dist[k][j];
  }
  const finite = dist.flat().filter((value) => Number.isFinite(value) && value > 0);
  const far = Math.max(320, (finite.length ? Math.max(...finite) : 300) * 0.6);
  const xs = order.map((name) => start.get(name)?.x ?? 0);
  const ys = order.map((name) => start.get(name)?.y ?? 0);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const nx = [...xs], ny = [...ys];
    for (let i = 0; i < n; i += 1) {
      let sx = 0, sy = 0, sw = 0;
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const connected = Number.isFinite(dist[i][j]);
        const d = connected ? dist[i][j] : far;
        // Unrelated pairs only ask loosely to keep apart.
        const w = (connected ? 1 : 0.15) / (d * d);
        const dx = xs[i] - xs[j], dy = ys[i] - ys[j];
        const actual = Math.hypot(dx, dy) || 1e-3;
        sx += w * (xs[j] + (d * dx) / actual);
        sy += w * (ys[j] + (d * dy) / actual);
        sw += w;
      }
      if (sw > 0) { nx[i] = sx / sw; ny[i] = sy / sw; }
    }
    for (let i = 0; i < n; i += 1) { xs[i] = nx[i]; ys[i] = ny[i]; }
  }
  return new Map(order.map((name, i) => [name, { x: xs[i], y: ys[i] }]));
}

export function layout(characters: CharacterInfo[], links: CoLink[], relations: Relation[], previous: Map<string, Point>, labelOf: (relation: Relation) => string) {
  const max = Math.max(1, ...characters.map((info) => info.lines));
  const known = (name: string) => previous.get(name);
  const result: GraphNode[] = characters.map((info) => ({ id: info.name, info, r: nodeRadius(info, max), x: known(info.name)?.x ?? 0, y: known(info.name)?.y ?? 0 }));
  if (result.every((node) => previous.has(node.id))) return result;

  const ids = new Set(result.map((node) => node.id));
  // One entry per related pair; several relations between the same two people stack their labels.
  const pairs = new Map<string, { a: string; b: string; width: number; height: number }>();
  for (const relation of relations) {
    if (!ids.has(relation.from) || !ids.has(relation.to)) continue;
    const key = relationPairKey(relation.from, relation.to);
    const pair = pairs.get(key) ?? { a: relation.from, b: relation.to, width: 0, height: -LABEL_STACK_GAP };
    const size = labelSize(labelOf(relation));
    pair.width = Math.max(pair.width, size.width);
    pair.height += size.height + LABEL_STACK_GAP;
    pairs.set(key, pair);
  }
  const baseOrder = seedOrder(characters, links, relations);
  // A few deterministic starting arrangements; keep the one with the fewest overlaps and crossings.
  const interleave = [...baseOrder.filter((_, i) => i % 2 === 0), ...baseOrder.filter((_, i) => i % 2 === 1)];
  const orders = [baseOrder, [...baseOrder].reverse(), interleave, [...interleave].reverse(),
    ...[1, 2, 3, 5].map((shift) => baseOrder.map((_, i) => baseOrder[(i * (shift + 1)) % baseOrder.length]).filter((name, i, list) => list.indexOf(name) === i))]
    .map((order) => order.length === baseOrder.length ? order : baseOrder);
  const fresh = previous.size === 0;
  const radius = new Map(result.map((node) => [node.id, node.r]));
  const gapOf = (pair: { a: string; b: string; width: number }) => (radius.get(pair.a) ?? 20) + (radius.get(pair.b) ?? 20) + Math.max(130, pair.width * 0.6 + 50);
  const ring = 80 * Math.sqrt(Math.max(1, characters.length));
  const circle = (order: string[]) => new Map(order.map((name, index) => {
    const angle = (index / Math.max(1, order.length)) * Math.PI * 2;
    return [name, { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring }];
  }));
  type Start = { positions: Map<string, Point>; settled: boolean };
  // Adding a character to an existing map: start it next to the people it is related to (or shares scenes with).
  const nearKnown = () => {
    const positions = circle(baseOrder);
    result.forEach((node, index) => {
      if (previous.has(node.id)) return;
      const neighbours = [
        ...[...pairs.values()].filter((pair) => pair.a === node.id || pair.b === node.id).map((pair) => (pair.a === node.id ? pair.b : pair.a)),
        ...links.filter((link) => link.a === node.id || link.b === node.id).map((link) => (link.a === node.id ? link.b : link.a)),
      ].map((name) => previous.get(name)).filter((point): point is Point => !!point);
      if (!neighbours.length) return;
      const angle = index * 2.399963;
      positions.set(node.id, {
        x: neighbours.reduce((sum, point) => sum + point.x, 0) / neighbours.length + Math.cos(angle) * 160,
        y: neighbours.reduce((sum, point) => sum + point.y, 0) / neighbours.length + Math.sin(angle) * 160,
      });
    });
    return positions;
  };
  let starts: Start[] = [{ positions: nearKnown(), settled: false }];
  if (fresh) {
    // Characters with no confirmed relation hang off the people they share the most scenes with.
    const relatedNames = new Set([...pairs.values()].flatMap((pair) => [pair.a, pair.b]));
    const edges = [...pairs.values()].map((pair) => ({ a: pair.a, b: pair.b, length: gapOf(pair) }));
    links.filter((link) => !relatedNames.has(link.a) || !relatedNames.has(link.b)).forEach((link) => edges.push({ a: link.a, b: link.b, length: 300 - Math.min(link.weight, 8) * 10 }));
    starts = [
      ...orders.slice(0, 4).map((order) => ({ positions: stressLayout(baseOrder, edges, circle(order)), settled: true })),
      ...orders.slice(0, 2).map((order) => ({ positions: circle(order), settled: false })),
    ];
  }
  let best: { score: number; positions: Map<string, Point> } | null = null;
  for (const start of starts) {
    const bodies: SimNode[] = result.map((node) => {
      const seeded = start.positions.get(node.id) ?? { x: 0, y: 0 };
      const point = known(node.id);
      const nameHalf = Math.max(node.r, Array.from(node.id).length * 7 + 6, 34);
      const body: SimNode = { id: node.id, r: node.r, hx: nameHalf + 10, up: node.r + 10, down: node.r + 48, x: point?.x ?? seeded.x, y: point?.y ?? seeded.y };
      // Positions the writer already has (saved or dragged) stay put; only new characters find a place.
      if (point) { body.fx = point.x; body.fy = point.y; }
      return body;
    });
    const byId = new Map(bodies.map((body) => [body.id, body]));
    const labels: LabelBody[] = [...pairs.values()].map((pair) => ({ a: byId.get(pair.a)!, b: byId.get(pair.b)!, hx: pair.width / 2 + 8, half: pair.height / 2 + 6 }));
    const simLinks: SimLink[] = [];
    // Long enough for the label to fit between the two characters.
    pairs.forEach((pair) => simLinks.push({ source: pair.a, target: pair.b, gap: gapOf(pair), pull: 0.6 }));
    // Shared scenes only pull gently, so they do not drag the relation structure apart.
    links.filter((link) => ids.has(link.a) && ids.has(link.b) && !pairs.has(relationPairKey(link.a, link.b))).forEach((link) => {
      simLinks.push({ source: link.a, target: link.b, gap: 260 - Math.min(link.weight, 8) * 8, pull: Math.min(0.06, 0.01 + link.weight * 0.006) });
    });
    const simulation = forceSimulation<SimNode>(bodies)
      .force('link', forceLink<SimNode, SimLink>(simLinks).id((node) => node.id).distance((link) => link.gap).strength((link) => link.pull))
      .force('charge', forceManyBody<SimNode>().strength((node) => (start.settled ? -120 : -520) - node.r * 8).distanceMax(1000))
      .force('rect', rectCollide(bodies, labels))
      .force('x', forceX<SimNode>(0).strength(0.04))
      .force('y', forceY<SimNode>(0).strength(0.05))
      .stop();
    if (fresh) simulation.force('center', forceCenter(0, 0));
    // A stress start is already untangled: only a gentle pass to clear overlaps.
    if (start.settled) simulation.alpha(0.3).force('x', null).force('y', null).force('charge', null);
    for (let tick = 0; tick < (start.settled ? 260 : fresh ? 500 : 260); tick += 1) simulation.tick();
    let overlapCount = 0;
    const boxes = [...bodies.map(boxOf), ...labels.map(labelBox)];
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) if (overlaps(boxes[i], boxes[j])) overlapCount += 1;
    const segments = [...pairs.values()].map((pair) => [byId.get(pair.a)!, byId.get(pair.b)!] as [SimNode, SimNode]);
    const score = overlapCount * 3 + crossings(segments) * 3;
    if (!best || score < best.score) best = { score, positions: new Map(bodies.map((body) => [body.id, { x: body.x ?? 0, y: body.y ?? 0 }])) };
  }
  result.forEach((node) => { const point = best!.positions.get(node.id)!; node.x = point.x; node.y = point.y; });
  return result;
}
