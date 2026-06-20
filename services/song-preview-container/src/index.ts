import { Container, getRandom } from "@cloudflare/containers";
import { env as workerEnv } from "cloudflare:workers";
import {
  containerInstanceCount,
  handleSongPreviewContainerRequest,
  songPreviewContainerEnvVars,
  SONG_PREVIEW_PORT,
  type SongPreviewContainerEnv,
} from "./handler";

declare global {
  namespace Cloudflare {
    interface Env extends SongPreviewContainerEnv {}
  }
}

export class SongPreviewContainer extends Container {
  defaultPort = SONG_PREVIEW_PORT;
  requiredPorts = [SONG_PREVIEW_PORT];
  sleepAfter = "10m";
  enableInternet = true;
  pingEndpoint = `localhost:${SONG_PREVIEW_PORT}/health`;
  envVars = songPreviewContainerEnvVars(workerEnv);
}

async function proxyToSongPreviewContainer(
  request: Request,
  env: SongPreviewContainerEnv,
): Promise<Response> {
  const container = await getRandom(
    env.SONG_PREVIEW_CONTAINER as unknown as DurableObjectNamespace<SongPreviewContainer>,
    containerInstanceCount(env),
  );
  return container.fetch(request);
}

export default {
  async fetch(
    request: Request,
    env: SongPreviewContainerEnv,
  ): Promise<Response> {
    return handleSongPreviewContainerRequest(request, env, proxyToSongPreviewContainer);
  },
};
