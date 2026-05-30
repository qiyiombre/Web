import type { LogEntry, TagNode, TagSimilarity } from '../types/domain';

type Point = { x: number; y: number; r: number };

interface LayoutRequest {
  requestId: number;
  tags: TagNode[];
  logs: LogEntry[];
  similarities: TagSimilarity[];
  manualTagPositions: Array<{ id: number; x: number; y: number }>;
  manualLogPositions: Array<{ id: number; x: number; y: number }>;
}

interface LayoutResponse {
  requestId: number;
  tagPositions: Array<{ id: number; x: number; y: number; r: number }>;
  logPositions: Array<{ id: number; x: number; y: number; r: number }>;
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const response = computeLayout(event.data);
  self.postMessage(response);
};

function computeLayout(request: LayoutRequest): LayoutResponse {
  const tags = request.tags;
  const logs = request.logs;
  const similarities = request.similarities ?? [];
  const manualTagPositions = new Map(request.manualTagPositions.map((item) => [item.id, { x: item.x, y: item.y }]));
  const manualLogPositions = new Map(request.manualLogPositions.map((item) => [item.id, { x: item.x, y: item.y }]));
  const tagPositions = new Map<number, Point>();
  const logPositions = new Map<number, Point>();
  const tagCount = Math.max(tags.length, 1);
  const baseRadius = Math.min(420, Math.max(170, 110 + tagCount * 24));

  tags.forEach((tag, index) => {
    const angle = (Math.PI * 2 * index) / tagCount - Math.PI / 2;
    const ringOffset = (index % 3) * 34;
    const x = Math.cos(angle) * (baseRadius + ringOffset);
    const y = Math.sin(angle) * (baseRadius + ringOffset) * 0.72;
    const r = 18 + Math.log2(tag.count + 1) * 7;
    const manual = manualTagPositions.get(tag.id);
    tagPositions.set(tag.id, { x: manual?.x ?? x, y: manual?.y ?? y, r });
  });

  applySimilarityLayout(tags, similarities, tagPositions, manualTagPositions);

  logs.forEach((log) => {
    const related = log.tags.map((tag) => tagPositions.get(tag.id)).filter(Boolean) as Point[];
    const seed = seeded(log.id);
    const jitterAngle = seed * Math.PI * 2;
    const jitterDistance = related.length <= 1 ? 64 + (seed % 1) * 38 : 18 + (seed % 1) * 20;
    const center =
      related.length > 0
        ? related.reduce(
            (acc, point) => ({
              x: acc.x + point.x / related.length,
              y: acc.y + point.y / related.length
            }),
            { x: 0, y: 0 }
          )
        : { x: Math.cos(jitterAngle) * 90, y: Math.sin(jitterAngle) * 90 };

    const manual = manualLogPositions.get(log.id);
    const autoX = center.x + Math.cos(jitterAngle) * jitterDistance;
    const autoY = center.y + Math.sin(jitterAngle) * jitterDistance;
    logPositions.set(log.id, {
      x: manual?.x ?? autoX,
      y: manual?.y ?? autoY,
      r: 6
    });
  });

  return {
    requestId: request.requestId,
    tagPositions: [...tagPositions.entries()].map(([id, point]) => ({ id, ...point })),
    logPositions: [...logPositions.entries()].map(([id, point]) => ({ id, ...point }))
  };
}

function applySimilarityLayout(
  tags: TagNode[],
  similarities: TagSimilarity[],
  tagPositions: Map<number, Point>,
  manualPositions: Map<number, { x: number; y: number }>
) {
  if (tags.length < 2 || similarities.length === 0) {
    return;
  }

  const basePositions = new Map([...tagPositions.entries()].map(([id, point]) => [id, { ...point }]));
  const tagById = new Map(tags.map((tag) => [tag.id, tag]));
  const movable = (id: number) => !manualPositions.has(id);
  const movePoint = (id: number, dx: number, dy: number) => {
    if (!movable(id)) {
      return;
    }
    const point = tagPositions.get(id);
    if (point) {
      point.x += dx;
      point.y += dy;
    }
  };

  for (let iteration = 0; iteration < 70; iteration += 1) {
    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        const a = tagPositions.get(tags[i].id);
        const b = tagPositions.get(tags[j].id);
        if (!a || !b) {
          continue;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const minDistance = a.r + b.r + 42;
        if (distance < minDistance) {
          const push = (minDistance - distance) * 0.035;
          const ux = dx / distance;
          const uy = dy / distance;
          movePoint(tags[i].id, -ux * push, -uy * push);
          movePoint(tags[j].id, ux * push, uy * push);
        }
      }
    }

    for (const similarity of similarities) {
      if (!tagById.has(similarity.tagAId) || !tagById.has(similarity.tagBId)) {
        continue;
      }
      const a = tagPositions.get(similarity.tagAId);
      const b = tagPositions.get(similarity.tagBId);
      if (!a || !b) {
        continue;
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = 340 - Math.min(1, similarity.score) * 230;
      const force = (distance - desired) * (0.012 + similarity.score * 0.018);
      const ux = dx / distance;
      const uy = dy / distance;
      movePoint(similarity.tagAId, ux * force, uy * force);
      movePoint(similarity.tagBId, -ux * force, -uy * force);
    }

    for (const tag of tags) {
      if (!movable(tag.id)) {
        continue;
      }
      const point = tagPositions.get(tag.id);
      const base = basePositions.get(tag.id);
      if (point && base) {
        point.x += (base.x - point.x) * 0.01;
        point.y += (base.y - point.y) * 0.01;
      }
    }
  }
}

function seeded(input: number) {
  const x = Math.sin(input * 999.91) * 10000;
  return x - Math.floor(x);
}

export {};
