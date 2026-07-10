import { mock } from "bun:test"

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
  WorkerEntrypoint: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
  RpcStub: class {},
  RpcTarget: class {},
}))

const { setNonPostgresControlPlaneClientFactoryForTests } = await import("../../src/lib/runtime-deps")
const { setTestLocalCommunityDbOpener } = await import("../../src/lib/communities/community-read-access")
const { openCommunityDb } = await import("../../src/lib/communities/community-db-factory")
const { createLibsqlTestClientAdapter } = await import("../support/libsql-test-client-adapter")

setNonPostgresControlPlaneClientFactoryForTests(createLibsqlTestClientAdapter)
setTestLocalCommunityDbOpener(async (env, repository, communityId) => {
  const handle = await openCommunityDb(env, repository, communityId)
  return { client: handle.client, close: handle.close }
})
