import { Hono } from "hono"
import { getCommunityByNamespaceRoute } from "../lib/communities/community-namespace-service"
import { handleRoute, requireRouteParam } from "./route-helpers"
import type { Env } from "../types"

const communityNamespace = new Hono<{ Bindings: Env }>()

communityNamespace.get(
  "/by-namespace/:namespaceLabel",
  handleRoute(async (c) => {
    const result = await getCommunityByNamespaceRoute({
      env: c.env,
      namespaceLabel: requireRouteParam(c.req.param("namespaceLabel"), "namespace_label"),
    })
    return c.json(result, 200)
  }),
)

export default communityNamespace
