import { Hono } from "hono"
import { getCommunityByNamespaceRoute } from "../lib/communities/community-namespace-service"
import { handleRoute } from "./route-helpers"
import type { Env } from "../types"

const communityNamespace = new Hono<{ Bindings: Env }>()

function routeParam(c: { req: { param(name: string): string | undefined } }, name: string): string {
  return c.req.param(name) ?? ""
}

communityNamespace.get(
  "/by-namespace/:namespaceLabel",
  handleRoute(async (c) => {
    const result = await getCommunityByNamespaceRoute({
      env: c.env,
      namespaceLabel: routeParam(c, "namespaceLabel"),
    })
    return c.json(result, 200)
  }),
)

export default communityNamespace
