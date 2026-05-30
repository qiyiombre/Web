import type { DraftLog, GraphData, Insight, LogEntry, NebulaMap, TagNode, TagSuggestion, UserAccount } from '../types/domain';

const API_BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: '请求失败' }));
    throw new Error(error.message ?? '请求失败');
  }

  return response.json() as Promise<T>;
}

export function getCurrentUser() {
  return request<{ user: UserAccount }>('/auth/me');
}

export function login(username: string, password: string) {
  return request<{ user: UserAccount }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

export function register(username: string, password: string) {
  return request<{ user: UserAccount }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

export function logout() {
  return request<{ ok: true }>('/auth/logout', {
    method: 'POST'
  });
}

export function listMaps() {
  return request<NebulaMap[]>('/maps');
}

export function createMap(name: string, description = '') {
  return request<NebulaMap>('/maps', {
    method: 'POST',
    body: JSON.stringify({ name, description })
  });
}

export function getGraph(mapId: number) {
  return request<GraphData>(`/maps/${mapId}/graph`);
}

export function createLog(payload: { mapId: number; title: string; content: string; tagNames: string[] }) {
  return request<LogEntry>('/logs', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function updateLog(id: number, payload: { title: string; content: string; tagNames: string[] }) {
  return request<LogEntry>(`/logs/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}

export function deleteLog(id: number) {
  return request<{ ok: true }>(`/logs/${id}`, {
    method: 'DELETE'
  });
}

export function suggestTags(mapId: number, content: string) {
  return request<TagSuggestion[]>('/tags/suggest', {
    method: 'POST',
    body: JSON.stringify({ mapId, content })
  });
}

export function createTag(payload: { mapId: number; name: string; color?: string }) {
  return request<TagNode>('/tags', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function updateTag(id: number, payload: { name: string; color?: string }) {
  return request<TagNode>(`/tags/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}

export function deleteTag(id: number) {
  return request<{ ok: true }>(`/tags/${id}`, {
    method: 'DELETE'
  });
}

export function getInsights(mapId: number) {
  return request<Insight>(`/maps/${mapId}/insights`);
}

export function generateAdvice(mapId: number) {
  return request<{ cached: boolean; suggestions: string[] }>(`/maps/${mapId}/advice`, {
    method: 'POST'
  });
}

const DB_NAME = 'nebula-insight-local';
const STORE_NAME = 'drafts';

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDraft(mapId: number, draft: DraftLog) {
  const db = await openDraftDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(draft, String(mapId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
}

export async function loadDraft(mapId: number) {
  const db = await openDraftDb();
  return new Promise<DraftLog | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(String(mapId));
    req.onsuccess = () => resolve(req.result as DraftLog | undefined);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

export async function clearDraft(mapId: number) {
  const db = await openDraftDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(String(mapId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
}
