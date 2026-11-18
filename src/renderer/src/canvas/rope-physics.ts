import type { Point, Rect } from '../../../shared/types';

export const SEGMENT_COUNT = 20;
export const POINT_COUNT = SEGMENT_COUNT + 1;
export const GRAVITY_Y = 1600;
export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 4;
export const DAMPING = 0.965;
export const SLACK_FACTOR = 1.05;
export const TIED_SLACK = 1.0;
export const CONSTRAINT_ITERATIONS = 8;
export const OBSTACLE_PADDING = 20;
export const OBSTACLE_CORNER_ZONE = OBSTACLE_PADDING * 1.5;
export const OBSTACLE_BLEND = 0.4;
export const SLEEP_THRESHOLD = 0.5;

export interface TieTarget {
  id: string;
  point: Point;
  tangent: Point;
}

export function staticRopePoints(start: Point, end: Point): Point[] {
  const span = Math.hypot(end.x - start.x, end.y - start.y);
  const sag = Math.min(Math.max(span * 0.14, 18), 90);
  const pts: Point[] = [];
  for (let i = 0; i <= SEGMENT_COUNT; i++) {
    const t = i / SEGMENT_COUNT;
    const parabola = 4 * t * (1 - t);
    pts.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t + sag * parabola,
    });
  }
  return pts;
}

export function pushOutOfObstacles(point: Point, obstacles: Rect[]): void {
  for (const rect of obstacles) {
    const minX = rect.x - OBSTACLE_PADDING;
    const maxX = rect.x + rect.width + OBSTACLE_PADDING;
    const minY = rect.y - OBSTACLE_PADDING;
    const maxY = rect.y + rect.height + OBSTACLE_PADDING;
    if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) continue;

    const toLeft = point.x - minX;
    const toRight = maxX - point.x;
    const toTop = point.y - minY;
    const toBottom = maxY - point.y;

    const nearLeft = toLeft < OBSTACLE_CORNER_ZONE;
    const nearRight = toRight < OBSTACLE_CORNER_ZONE;
    const nearTop = toTop < OBSTACLE_CORNER_ZONE;
    const nearBottom = toBottom < OBSTACLE_CORNER_ZONE;

    let targetX = point.x;
    let targetY = point.y;

    if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
      const cornerX = nearLeft ? minX : maxX;
      const cornerY = nearTop ? minY : maxY;
      const dx = point.x - cornerX;
      const dy = point.y - cornerY;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-3) {
        targetX = cornerX + (dx / dist) * OBSTACLE_PADDING;
        targetY = cornerY + (dy / dist) * OBSTACLE_PADDING;
      }
    } else {
      const minDist = Math.min(toLeft, toRight, toTop, toBottom);
      if (minDist === toLeft) targetX = minX;
      else if (minDist === toRight) targetX = maxX;
      else if (minDist === toTop) targetY = minY;
      else targetY = maxY;
    }

    point.x += (targetX - point.x) * OBSTACLE_BLEND;
    point.y += (targetY - point.y) * OBSTACLE_BLEND;
  }
}

function resolveTieClamps(
  pinStart: Point,
  pinEnd: Point,
  points: Point[],
  tieTargets: TieTarget[]
): {
  dist: number;
  pins: Array<{ index: number; target: Point }>;
  segmentLengths: number[] | null;
} {
  const count = points.length;
  const chordX = pinEnd.x - pinStart.x;
  const chordY = pinEnd.y - pinStart.y;
  const chordLength = Math.hypot(chordX, chordY);
  if (tieTargets.length === 0) {
    return { dist: chordLength, pins: [], segmentLengths: null };
  }

  const progress = (pt: Point) => (pt.x - pinStart.x) * chordX + (pt.y - pinStart.y) * chordY;
  const ordered = [...tieTargets].sort((a, b) => progress(a.point) - progress(b.point));

  const legs: number[] = [];
  let previous = pinStart;
  let routed = 0;
  for (const c of ordered) {
    const leg = Math.hypot(c.point.x - previous.x, c.point.y - previous.y);
    legs.push(leg);
    routed += leg;
    previous = c.point;
  }
  routed += Math.hypot(pinEnd.x - previous.x, pinEnd.y - previous.y);
  const dist = Math.max(chordLength, routed);
  if (routed <= 1e-3) return { dist, pins: [], segmentLengths: null };

  const centers: Array<{ index: number; point: Point; tangent: Point }> = [];
  let cumulative = 0;
  let lastIndex = -1;
  for (let k = 0; k < ordered.length; k++) {
    const c = ordered[k];
    const leg = legs[k];
    cumulative += leg;
    const index = Math.min(
      Math.max(Math.round((cumulative / routed) * SEGMENT_COUNT), lastIndex + 3, 1),
      count - 2
    );
    if (index <= lastIndex) continue;
    lastIndex = index;
    centers.push({ index, point: c.point, tangent: c.tangent });
  }
  if (centers.length === 0) return { dist, pins: [], segmentLengths: null };

  const segmentLengths = new Array<number>(count - 1).fill(0);
  let spanStartIndex = 0;
  let spanStartPoint = pinStart;
  const waypoints = [
    ...centers,
    { index: count - 1, point: pinEnd, tangent: { x: 0, y: 0 } },
  ];
  for (const wp of waypoints) {
    const span = Math.hypot(wp.point.x - spanStartPoint.x, wp.point.y - spanStartPoint.y);
    const per = (Math.max(span, 1) * TIED_SLACK) / (wp.index - spanStartIndex);
    for (let s = spanStartIndex; s < wp.index; s++) segmentLengths[s] = per;
    spanStartIndex = wp.index;
    spanStartPoint = wp.point;
  }

  const pins: Array<{ index: number; target: Point }> = [];
  for (const center of centers) {
    const aheadA = points[Math.max(center.index - 1, 0)];
    const aheadB = points[Math.min(center.index + 1, count - 1)];
    if (!aheadA || !aheadB) continue;
    const dot =
      (aheadB.x - aheadA.x) * center.tangent.x + (aheadB.y - aheadA.y) * center.tangent.y;
    const sign = dot >= 0 ? 1 : -1;
    const dirX = center.tangent.x * sign;
    const dirY = center.tangent.y * sign;
    const before = segmentLengths[center.index - 1];
    if (center.index - 1 >= 1 && before !== undefined) {
      pins.push({
        index: center.index - 1,
        target: { x: center.point.x - dirX * before, y: center.point.y - dirY * before },
      });
    }
    pins.push({ index: center.index, target: center.point });
    const after = segmentLengths[center.index];
    if (center.index + 1 <= count - 2 && after !== undefined) {
      pins.push({
        index: center.index + 1,
        target: { x: center.point.x + dirX * after, y: center.point.y + dirY * after },
      });
    }
  }

  return { dist, pins, segmentLengths };
}

export class Rope {
  points: Point[];
  prev: Point[];
  pinStart: Point;
  pinEnd: Point;
  lastMovement = 0;

  constructor(start: Point, end: Point, restoredPoints?: Point[]) {
    this.pinStart = { ...start };
    this.pinEnd = { ...end };
    this.points =
      restoredPoints?.length === POINT_COUNT
        ? restoredPoints.map((p) => ({ ...p }))
        : staticRopePoints(start, end);
    this.prev = this.points.map((p) => ({ ...p }));
  }

  settle(steps: number, obstacles: Rect[], tieTargets: TieTarget[]): void {
    for (let i = 0; i < steps; i++) {
      this.step(FIXED_DT, obstacles, tieTargets);
    }
    this.lastMovement = 0;
  }

  step(dt: number, obstacles: Rect[], tieTargets: TieTarget[] = []): void {
    const points = this.points;
    const prev = this.prev;
    const count = points.length;
    const gravity = GRAVITY_Y * dt * dt;

    for (let i = 1; i < count - 1; i++) {
      const cur = points[i];
      const prv = prev[i];
      if (!cur || !prv) continue;
      const vx = (cur.x - prv.x) * DAMPING;
      const vy = (cur.y - prv.y) * DAMPING;
      prev[i] = { x: cur.x, y: cur.y };
      points[i] = { x: cur.x + vx, y: cur.y + vy + gravity };
    }

    points[0] = { ...this.pinStart };
    prev[0] = { ...this.pinStart };
    const last = count - 1;
    points[last] = { ...this.pinEnd };
    prev[last] = { ...this.pinEnd };

    const clamp = resolveTieClamps(this.pinStart, this.pinEnd, points, tieTargets);
    const targetLength =
      Math.max(clamp.dist * (clamp.pins.length === 0 ? SLACK_FACTOR : TIED_SLACK), 40) /
      SEGMENT_COUNT;

    for (let iter = 0; iter < CONSTRAINT_ITERATIONS; iter++) {
      for (let i = 0; i < count - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 1e-3) continue;
        const restLength = clamp.segmentLengths?.[i] ?? targetLength;
        const diff = ((dist - restLength) / dist) * 0.5;
        const ox = dx * diff;
        const oy = dy * diff;
        if (i !== 0) {
          a.x += ox;
          a.y += oy;
        }
        if (i + 1 !== count - 1) {
          b.x -= ox;
          b.y -= oy;
        }
      }

      if (obstacles.length > 0) {
        for (let i = 1; i < count - 1; i++) {
          pushOutOfObstacles(points[i], obstacles);
        }
      }

      for (const pin of clamp.pins) {
        points[pin.index] = { ...pin.target };
      }
      points[0] = { ...this.pinStart };
      points[last] = { ...this.pinEnd };
    }

    for (const pin of clamp.pins) {
      points[pin.index] = { ...pin.target };
      prev[pin.index] = { ...pin.target };
    }

    let movement = 0;
    for (let i = 1; i < count - 1; i++) {
      movement += Math.abs(points[i].x - prev[i].x) + Math.abs(points[i].y - prev[i].y);
    }
    this.lastMovement = movement;
  }
}

export function getEdgeAnchors(rectA: Rect, rectB: Rect): { start: Point; end: Point } {
  const cxA = rectA.x + rectA.width / 2;
  const cyA = rectA.y + rectA.height / 2;
  const cxB = rectB.x + rectB.width / 2;
  const cyB = rectB.y + rectB.height / 2;

  const dx = cxB - cxA;
  const dy = cyB - cyA;

  if (Math.abs(dx) >= Math.abs(dy) * 0.7) {
    if (dx >= 0) {
      return {
        start: { x: rectA.x + rectA.width, y: cyA },
        end: { x: rectB.x, y: cyB },
      };
    }
    return {
      start: { x: rectA.x, y: cyA },
      end: { x: rectB.x + rectB.width, y: cyB },
    };
  }

  if (dy >= 0) {
    return {
      start: { x: cxA, y: rectA.y + rectA.height },
      end: { x: cxB, y: rectB.y },
    };
  }
  return {
    start: { x: cxA, y: rectA.y },
    end: { x: cxB, y: rectB.y + rectB.height },
  };
}

export function pointsToSmoothSvgPath(points: Point[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

export function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: a1.x + t * d1x, y: a1.y + t * d1y };
  }
  return null;
}
