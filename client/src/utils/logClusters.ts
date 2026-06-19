import type { LogEntry } from '../types/domain';

export type ClusterPoint = {
  id: string;
  logIds: number[];
  x: number;
  y: number;
  r: number;
  primaryTagId: number | null;
  count: number;
  level: 'parent' | 'child';
};

type LayoutPoint = { x: number; y: number; r: number };

const CLUSTER_START_COUNT = 120;
const CLUSTER_END_COUNT = 80;
const CLUSTER_EXPAND_SCALE = 1.35;
const CLUSTER_CELL_SIZE = 230;
const CHILD_CLUSTER_CELL_SIZE = 116;
const ACTIVE_CLUSTER_SINGLE_LIMIT = 36;

export function shouldClusterLogs(visibleCount: number, scale: number, enabled = true) {
  if (!enabled) return false;
  if (visibleCount <= CLUSTER_END_COUNT) return false;
  if (visibleCount > 260) return scale < 2.25;
  if (visibleCount > CLUSTER_START_COUNT) return scale < 1.75;
  return scale < CLUSTER_EXPAND_SCALE;
}

export function buildLogClusters(
  logs: LogEntry[],
  logPositions: Map<number, LayoutPoint>,
  tagPositions: Map<number, LayoutPoint>,
  options: {
    selectedLogId?: number | null;
    focusPulseLogId?: number | null;
    activeTagIds?: Set<number>;
    expandedLogIds?: Set<number> | null;
    minimumClusterSize?: number;
  } = {}
) {
  const singles = new Set<number>();
  const expandedLogs: LogEntry[] = [];
  const groups = new Map<string, { logIds: number[]; sumX: number; sumY: number; primaryTagId: number | null }>();
  const minimumClusterSize = options.minimumClusterSize ?? 3;

  for (const log of logs) {
    const point = logPositions.get(log.id);
    if (!point) continue;
    if (log.id === options.selectedLogId || log.id === options.focusPulseLogId) {
      singles.add(log.id);
      continue;
    }
    if (options.expandedLogIds?.has(log.id)) {
      expandedLogs.push(log);
      continue;
    }

    const primaryTagId = resolvePrimaryTagId(log, tagPositions, options.activeTagIds);
    addLogToGroup(groups, log.id, point, primaryTagId, CLUSTER_CELL_SIZE, 'parent');
  }

  const clusters: ClusterPoint[] = [];
  flushGroups(groups, clusters, singles, minimumClusterSize, 'parent');

  if (expandedLogs.length <= ACTIVE_CLUSTER_SINGLE_LIMIT) {
    for (const log of expandedLogs) singles.add(log.id);
  } else {
    const childGroups = new Map<string, { logIds: number[]; sumX: number; sumY: number; primaryTagId: number | null }>();
    for (const log of expandedLogs) {
      const point = logPositions.get(log.id);
      if (!point) continue;
      const primaryTagId = resolvePrimaryTagId(log, tagPositions, options.activeTagIds);
      addLogToGroup(childGroups, log.id, point, primaryTagId, CHILD_CLUSTER_CELL_SIZE, 'child');
    }
    flushGroups(childGroups, clusters, singles, 4, 'child');
  }

  return { clusters, singleLogIds: singles };
}

function addLogToGroup(
  groups: Map<string, { logIds: number[]; sumX: number; sumY: number; primaryTagId: number | null }>,
  logId: number,
  point: LayoutPoint,
  primaryTagId: number | null,
  cellSize: number,
  level: 'parent' | 'child'
) {
  const cellX = Math.round(point.x / cellSize);
  const cellY = Math.round(point.y / cellSize);
  const key = `${level}:${primaryTagId ?? 'none'}:${cellX}:${cellY}`;
  const group = groups.get(key) ?? { logIds: [], sumX: 0, sumY: 0, primaryTagId };
  group.logIds.push(logId);
  group.sumX += point.x;
  group.sumY += point.y;
  groups.set(key, group);
}

function flushGroups(
  groups: Map<string, { logIds: number[]; sumX: number; sumY: number; primaryTagId: number | null }>,
  clusters: ClusterPoint[],
  singles: Set<number>,
  minimumClusterSize: number,
  level: 'parent' | 'child'
) {
  for (const [key, group] of groups) {
    if (group.logIds.length < minimumClusterSize) {
      for (const logId of group.logIds) singles.add(logId);
      continue;
    }
    const count = group.logIds.length;
    clusters.push({
      id: key,
      logIds: group.logIds,
      x: group.sumX / count,
      y: group.sumY / count,
      r: (level === 'child' ? 7 : 10) + Math.log2(count + 1) * (level === 'child' ? 4.2 : 4.9),
      primaryTagId: group.primaryTagId,
      count,
      level
    });
  }
}

function resolvePrimaryTagId(log: LogEntry, tagPositions: Map<number, LayoutPoint>, activeTagIds?: Set<number>) {
  const activeTag = log.tags.find((tag) => activeTagIds?.has(tag.id) && tagPositions.has(tag.id));
  if (activeTag) return activeTag.id;
  const positioned = log.tags
    .filter((tag) => tagPositions.has(tag.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return positioned[0]?.id ?? null;
}
