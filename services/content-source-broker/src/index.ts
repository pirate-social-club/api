import { handleContentSourceBrokerRequest, type ContentSourceBrokerEnv } from "./handler"

declare global {
  namespace Cloudflare {
    interface Env extends ContentSourceBrokerEnv {}
  }
}

export default {
  fetch(request: Request, env: ContentSourceBrokerEnv): Promise<Response> {
    return handleContentSourceBrokerRequest(request, env)
  },
}
