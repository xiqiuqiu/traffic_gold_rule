import type { CatalogOptions, ObservationReport, ObservationRow, PromoteTarget, ReviewStatus } from '../types/catalog';

async function request<T>(
  url: string,
  userId: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userId,
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // ignore json parse error
    }
    throw new Error(message);
  }

  return (await res.json()) as T;
}

export const api = {
  fieldOptions(userId: string) {
    return request<CatalogOptions>('/api/catalog-options', userId);
  },

  getCodebook(userId: string) {
    return request<{
      groups: Array<{
        authority: string;
        legal: boolean;
        fields: { code: string; name: string }[];
        count: number;
      }>;
      unbound: Array<{ code: string; name: string; reason: string }>;
    }>('/api/codebook', userId);
  },

  getCodes(
    userId: string,
    authority: string,
    page: { q?: string; offset?: number; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (page.q) params.set('q', page.q);
    params.set('offset', String(page.offset ?? 0));
    params.set('limit', String(page.limit ?? 40));
    return request<{
      authority: string;
      total: number;
      offset: number;
      limit: number;
      codes: Array<{ dmz: string; label: string; aliases?: string[] }>;
    }>(`/api/codebook/${encodeURIComponent(authority)}?${params}`, userId);
  },

  addCode(userId: string, authority: string, dmz: string, label: string) {
    return request<{ dmz: string; label: string }>(
      `/api/codebook/${encodeURIComponent(authority)}/codes`,
      userId,
      { method: 'POST', body: JSON.stringify({ dmz, label }) },
    );
  },

  renameCode(userId: string, authority: string, dmz: string, label: string) {
    return request<{ dmz: string; label: string }>(
      `/api/codebook/${encodeURIComponent(authority)}/codes/${encodeURIComponent(dmz)}`,
      userId,
      { method: 'PATCH', body: JSON.stringify({ label }) },
    );
  },

  removeCode(userId: string, authority: string, dmz: string) {
    return request<{ dmz: string; label: string }>(
      `/api/codebook/${encodeURIComponent(authority)}/codes/${encodeURIComponent(dmz)}`,
      userId,
      { method: 'DELETE' },
    );
  },

  getReadings(userId: string, authority: string) {
    return request<{
      aliases: Array<{ phrase: string; dmz: string; label: string }>;
      groups: Array<{ name: string; authority: string; members: Array<{ dmz: string; label: string }> }>;
    }>(`/api/codebook/${encodeURIComponent(authority)}/readings`, userId);
  },

  addAlias(userId: string, authority: string, phrase: string, dmz: string) {
    return request<{ phrase: string; dmz: string; label: string }>(
      `/api/codebook/${encodeURIComponent(authority)}/aliases`,
      userId,
      { method: 'POST', body: JSON.stringify({ phrase, dmz }) },
    );
  },

  removeAlias(userId: string, authority: string, phrase: string) {
    return request<{ phrase: string; dmz: string; label: string }>(
      `/api/codebook/${encodeURIComponent(authority)}/aliases`,
      userId,
      { method: 'DELETE', body: JSON.stringify({ phrase }) },
    );
  },

  saveGroup(userId: string, authority: string, name: string, members: string[]) {
    return request<{ name: string; authority: string; members: Array<{ dmz: string; label: string }> }>(
      `/api/codebook/${encodeURIComponent(authority)}/groups`,
      userId,
      { method: 'PUT', body: JSON.stringify({ name, members }) },
    );
  },

  removeGroup(userId: string, authority: string, name: string) {
    return request<{ name: string }>(
      `/api/codebook/${encodeURIComponent(authority)}/groups`,
      userId,
      { method: 'DELETE', body: JSON.stringify({ name }) },
    );
  },

  expandQuery(userId: string, field: string, q: string) {
    const params = new URLSearchParams({ field, q });
    return request<{
      fieldCode: string;
      authority: string | null;
      dmz: string[];
      extension: string | null;
      via: 'dmz' | 'label' | 'alias' | 'group' | 'extension' | 'none';
    }>(`/api/codebook-expand?${params}`, userId);
  },

  getObservations(userId: string) {
    return request<ObservationReport>('/api/tag-observations', userId);
  },

  reviewObservation(
    userId: string,
    input: { fieldCode: string; textKey: string; status: ReviewStatus; weight?: number },
  ) {
    return request<ObservationRow>('/api/tag-observations/review', userId, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  promoteObservation(
    userId: string,
    input: { fieldCode: string; textKey: string; target: PromoteTarget },
  ) {
    return request<ObservationRow>('/api/tag-observations/promote', userId, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getExtensionTags(userId: string, field = '') {
    const params = field ? `?field=${encodeURIComponent(field)}` : '';
    return request<{
      tags: Array<{ extCode: string; fieldCode: string; fieldName: string; label: string; aliases: string[] }>;
      fields: Array<{ code: string; name: string }>;
    }>(`/api/extension-tags${params}`, userId);
  },

  createExtensionTag(userId: string, fieldCode: string, label: string, aliases: string[]) {
    return request<{ extCode: string; fieldCode: string; fieldName: string; label: string; aliases: string[] }>(
      '/api/extension-tags',
      userId,
      { method: 'POST', body: JSON.stringify({ fieldCode, label, aliases }) },
    );
  },

  updateExtensionTag(
    userId: string,
    extCode: string,
    patch: { label?: string; aliases?: string[] },
  ) {
    return request<{ extCode: string; fieldCode: string; fieldName: string; label: string; aliases: string[] }>(
      `/api/extension-tags/${encodeURIComponent(extCode)}`,
      userId,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
  },

  removeExtensionTag(userId: string, extCode: string) {
    return request<{ extCode: string; label: string }>(
      `/api/extension-tags/${encodeURIComponent(extCode)}`,
      userId,
      { method: 'DELETE' },
    );
  },
};
