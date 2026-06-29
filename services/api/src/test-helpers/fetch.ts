type FetchMock = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>

export function mockFetch(handler: FetchMock): typeof fetch {
  return Object.assign(handler, {
    preconnect: (() => {}) as typeof fetch.preconnect,
  }) as typeof fetch
}
