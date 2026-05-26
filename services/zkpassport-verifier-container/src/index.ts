import { Container, getRandom } from "@cloudflare/containers";
import { env as workerEnv } from "cloudflare:workers";
import {
  containerInstanceCount,
  handleVerifierContainerRequest,
  verifierContainerEnvVars,
  VERIFIER_PORT,
  type VerifierContainerEnv,
} from "./handler";

declare global {
  namespace Cloudflare {
    interface Env extends VerifierContainerEnv {}
  }
}

export class ZkPassportVerifierContainer extends Container {
  defaultPort = VERIFIER_PORT;
  requiredPorts = [VERIFIER_PORT];
  sleepAfter = "10m";
  enableInternet = true;
  pingEndpoint = `localhost:${VERIFIER_PORT}/health`;
  envVars = verifierContainerEnvVars(workerEnv);
}

async function proxyToVerifierContainer(
  request: Request,
  env: VerifierContainerEnv,
): Promise<Response> {
  const container = await getRandom(
    env.ZKPASSPORT_VERIFIER_CONTAINER as unknown as DurableObjectNamespace<ZkPassportVerifierContainer>,
    containerInstanceCount(env),
  );
  return container.fetch(request);
}

export default {
  async fetch(
    request: Request,
    env: VerifierContainerEnv,
  ): Promise<Response> {
    return handleVerifierContainerRequest(request, env, proxyToVerifierContainer);
  },
};
