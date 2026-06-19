import type { LayoutMode, LogEntry, TagGroup, TagNode, TagSimilarity } from '../types/domain';

type Point = { x: number; y: number; r: number };
type WorkerGroup = { id: string; name: string; tagIds: number[] };

interface LayoutRequest {
  requestId: number;
  tags: TagNode[];
  logs: LogEntry[];
  similarities: TagSimilarity[];
  tagGroups: TagGroup[];
  layoutMode: LayoutMode;
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
  const tagGroups = request.tagGroups ?? [];
  const layoutMode = request.layoutMode ?? 'semantic';
  const manualTagPositions = new Map(request.manualTagPositions.map((item) => [item.id, { x: item.x, y: item.y }]));
  const manualLogPositions = new Map(request.manualLogPositions.map((item) => [item.id, { x: item.x, y: item.y }]));
  const tagPositions = new Map<number, Point>();
  const logPositions = new Map<number, Point>();
  const densityScale = logDensityScale(logs.length);

  if (layoutMode === 'domain') {
    applyDomainLayout(tags, tagGroups, tagPositions, manualTagPositions, densityScale);
  } else {
    applyOrbitLayout(tags, tagPositions, manualTagPositions, densityScale);
    applySimilarityLayout(tags, similarities, tagPositions, manualTagPositions);
    relaxTagCollisions(tags, tagPositions, manualTagPositions, 128, 150 * (1 + (densityScale - 1) * 0.16));
  }

  logs.forEach((log) => {
    const related = log.tags.map((tag) => tagPositions.get(tag.id)).filter(Boolean) as Point[];
    const seed = seeded(log.id);
    const jitterAngle = seed * Math.PI * 2;
    const logSpread = 1 + (densityScale - 1) * 0.74;
    const jitterDistance = (related.length <= 1 ? 90 + (seed % 1) * 110 : 30 + (seed % 1) * 50) * logSpread;
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
      r: 4.6
    });
  });

  relaxLogCollisions(
    logs,
    logPositions,
    manualLogPositions,
    Math.round(60 + (densityScale - 1) * 36),
    48 * (1 + (densityScale - 1) * 0.55)
  );

  return {
    requestId: request.requestId,
    tagPositions: [...tagPositions.entries()].map(([id, point]) => ({ id, ...point })),
    logPositions: [...logPositions.entries()].map(([id, point]) => ({ id, ...point }))
  };
}

function applyOrbitLayout(
  tags: TagNode[],
  tagPositions: Map<number, Point>,
  manualPositions: Map<number, { x: number; y: number }>,
  densityScale = 1
) {
  const tagCount = Math.max(tags.length, 1);
  const baseRadius = Math.max(500, 350 + tagCount * 80) * (1 + (densityScale - 1) * 0.42);

  tags.forEach((tag, index) => {
    const angle = (Math.PI * 2 * index) / tagCount - Math.PI / 2;
    const ringOffset = (index % 5) * 86;
    const x = Math.cos(angle) * (baseRadius + ringOffset);
    const y = Math.sin(angle) * (baseRadius + ringOffset) * 0.86;
    const r = tagRadius(tag);
    const manual = manualPositions.get(tag.id);
    tagPositions.set(tag.id, { x: manual?.x ?? x, y: manual?.y ?? y, r });
  });
}

function applyDomainLayout(
  tags: TagNode[],
  tagGroups: TagGroup[],
  tagPositions: Map<number, Point>,
  manualPositions: Map<number, { x: number; y: number }>,
  densityScale = 1
) {
  const groups = normalizeWorkerGroups(tags, tagGroups);
  if (groups.length === 0) {
    applyOrbitLayout(tags, tagPositions, manualPositions, densityScale);
    return;
  }

  const tagById = new Map(tags.map((tag) => [tag.id, tag]));
  const groupCount = groups.length;
  const galaxyRadius =
    groupCount === 1 ? 0 : Math.max(600, 450 + groupCount * 180 + Math.sqrt(tags.length) * 60) * (1 + (densityScale - 1) * 0.36);

  groups.forEach((group, groupIndex) => {
    const groupTags = group.tagIds
      .map((id) => tagById.get(id))
      .filter((tag): tag is TagNode => Boolean(tag))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    if (groupTags.length === 0) {
      return;
    }

    const groupAngle = (Math.PI * 2 * groupIndex) / groupCount - Math.PI / 2;
    const center = {
      x: Math.cos(groupAngle) * galaxyRadius,
      y: Math.sin(groupAngle) * galaxyRadius * 0.76
    };
    const innerRadius = Math.max(200, 120 + Math.sqrt(groupTags.length) * 90) * (1 + (densityScale - 1) * 0.34);

    groupTags.forEach((tag, index) => {
      const r = tagRadius(tag);
      const manual = manualPositions.get(tag.id);
      if (manual) {
        tagPositions.set(tag.id, { x: manual.x, y: manual.y, r });
        return;
      }

      const localAngle = (Math.PI * 2 * index) / Math.max(1, groupTags.length) + seeded(tag.id * 31 + groupIndex) * 0.32;
      const ring = groupTags.length === 1 ? 0 : innerRadius + (index % 3) * 46;
      tagPositions.set(tag.id, {
        x: center.x + Math.cos(localAngle) * ring,
        y: center.y + Math.sin(localAngle) * ring * 0.82,
        r
      });
    });
  });

  relaxTagCollisions(tags, tagPositions, manualPositions, 112, 168 * (1 + (densityScale - 1) * 0.16));
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

  for (let iteration = 0; iteration < 132; iteration += 1) {
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
        const minDistance = a.r + b.r + 150;
        if (distance < minDistance) {
          const push = (minDistance - distance) * 0.068;
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
      const desired = 500 - Math.min(1, similarity.score) * 300;
      const force = (distance - desired) * (0.015 + similarity.score * 0.02);
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
        point.x += (base.x - point.x) * 0.0025;
        point.y += (base.y - point.y) * 0.0025;
      }
    }
  }
}

function relaxTagCollisions(
  tags: TagNode[],
  tagPositions: Map<number, Point>,
  manualPositions: Map<number, { x: number; y: number }>,
  iterations: number,
  padding: number
) {
  const movable = (id: number) => !manualPositions.has(id);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
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
        const minDistance = a.r + b.r + padding;
        if (distance >= minDistance) {
          continue;
        }
        const push = (minDistance - distance) * 0.04;
        const ux = dx / distance;
        const uy = dy / distance;
        if (movable(tags[i].id)) {
          a.x -= ux * push;
          a.y -= uy * push;
        }
        if (movable(tags[j].id)) {
          b.x += ux * push;
          b.y += uy * push;
        }
      }
    }
  }
}

function relaxLogCollisions(
  logs: LogEntry[],
  logPositions: Map<number, Point>,
  manualPositions: Map<number, { x: number; y: number }>,
  iterations: number,
  padding: number
) {
  const movable = (id: number) => !manualPositions.has(id);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let i = 0; i < logs.length; i += 1) {
      for (let j = i + 1; j < logs.length; j += 1) {
        const a = logPositions.get(logs[i].id);
        const b = logPositions.get(logs[j].id);
        if (!a || !b) {
          continue;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const minDistance = a.r + b.r + padding;
        if (distance >= minDistance) {
          continue;
        }
        const push = (minDistance - distance) * 0.05;
        const ux = dx / distance;
        const uy = dy / distance;
        if (movable(logs[i].id)) {
          a.x -= ux * push;
          a.y -= uy * push;
        }
        if (movable(logs[j].id)) {
          b.x += ux * push;
          b.y += uy * push;
        }
      }
    }
  }
}

function normalizeWorkerGroups(tags: TagNode[], tagGroups: TagGroup[]): WorkerGroup[] {
  const validIds = new Set(tags.map((tag) => tag.id));
  const assigned = new Set<number>();
  const groups: WorkerGroup[] = [];

  for (const group of tagGroups) {
    const tagIds = [...new Set((group.tagIds ?? []).map(Number).filter((id) => validIds.has(id) && !assigned.has(id)))];
    if (tagIds.length === 0) {
      continue;
    }
    for (const id of tagIds) {
      assigned.add(id);
    }
    groups.push({
      id: group.id,
      name: group.name,
      tagIds
    });
  }

  const missing = tags.map((tag) => tag.id).filter((id) => !assigned.has(id));
  if (missing.length > 0) {
    groups.push({ id: 'group-other', name: '其他', tagIds: missing });
  }

  return groups;
}

function tagRadius(tag: TagNode) {
  return 20 + Math.log2(tag.count + 1) * 5.8;
}

function logDensityScale(count: number) {
  if (count <= 120) {
    return 1;
  }
  return Math.min(2.35, Math.sqrt(count / 120));
}

function seeded(input: number) {
  const x = Math.sin(input * 999.91) * 10000;
  return x - Math.floor(x);
}

export {};
