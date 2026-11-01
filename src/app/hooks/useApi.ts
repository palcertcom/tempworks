import { useState, useCallback } from 'react';
import type { ApiError } from '../services/api';

interface UseApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useApi<T>(
  apiFn: (...args: any[]) => Promise<T>,
) {
  const [state, setState] = useState<UseApiState<T>>({
    data: null,
    loading: false,
    error: null,
  });

  const execute = useCallback(
    async (...args: any[]): Promise<T | null> => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const result = await apiFn(...args);
        setState({ data: result, loading: false, error: null });
        return result;
      } catch (err: any) {
        const message =
          (err as ApiError).message || err?.message || 'An unexpected error occurred';
        setState((s) => ({ ...s, loading: false, error: message }));
        return null;
      }
    },
    [apiFn],
  );

  return { ...state, execute };
}

export function usePaginatedApi<T>(
  apiFn: (params: Record<string, any>) => Promise<{ data: T[]; meta: any }>,
  defaultParams: Record<string, any> = {},
) {
  const [items, setItems] = useState<T[]>([]);
  const [meta, setMeta] = useState<{ total: number; page: number; limit: number; totalPages: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(
    async (params: Record<string, any> = {}) => {
      setLoading(true);
      setError(null);
      try {
        const merged = { ...defaultParams, ...params };
        const result = await apiFn(merged);
        setItems(result.data);
        setMeta(result.meta);
        return result;
      } catch (err: any) {
        const message = err?.message || 'Failed to load data';
        setError(message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [apiFn, JSON.stringify(defaultParams)],
  );

  return { items, meta, loading, error, fetch };
}
