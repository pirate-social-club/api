export type ConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }
