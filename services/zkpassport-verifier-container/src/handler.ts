export const VERIFIER_PORT = 8794;
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CONTAINER_INSTANCES = 1;
export const MAX_CONTAINER_INSTANCES = 20;

export type VerifierContainerEnv = {
  ENVIRONMENT?: string;
  ZKPASSPORT_VERIFIER_CONTAINER: DurableObjectNamespace;
  ZKPASSPORT_VERIFIER_CONTAINER_INSTANCES?: string;
  ZKPASSPORT_VERIFIER_MAX_BODY_BYTES?: string;
  ZKPASSPORT_VERIFIER_SHARED_SECRET?: string;
  ZKPASSPORT_VERIFIER_WRITING_DIRECTORY?: string;
};

export type VerifierContainerProxy = (
  request: Request,
  env: VerifierContainerEnv,
) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

function trimEnv(value: string | undefined): string {
  return value?.trim() ?? "";
}

function jsonResponse(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(trimEnv(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function containerInstanceCount(env: VerifierContainerEnv): number {
  return Math.min(
    MAX_CONTAINER_INSTANCES,
    parsePositiveInteger(env.ZKPASSPORT_VERIFIER_CONTAINER_INSTANCES, DEFAULT_CONTAINER_INSTANCES),
  );
}

function verifierMaxBodyBytes(env: VerifierContainerEnv): number {
  return parsePositiveInteger(env.ZKPASSPORT_VERIFIER_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

function requireVerifierAuth(request: Request, env: VerifierContainerEnv): Response | null {
  const sharedSecret = trimEnv(env.ZKPASSPORT_VERIFIER_SHARED_SECRET);
  if (!sharedSecret) {
    return jsonResponse({
      code: "not_configured",
      message: "ZKPassport verifier shared secret is not configured",
    }, 503);
  }

  if (!constantTimeEqual(bearerToken(request), sharedSecret)) {
    return jsonResponse({ code: "unauthorized", message: "Unauthorized" }, 401);
  }

  return null;
}

function rejectOversizedBody(request: Request, env: VerifierContainerEnv): Response | null {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > verifierMaxBodyBytes(env)) {
    return jsonResponse({ code: "payload_too_large", message: "Request body is too large" }, 413);
  }
  return null;
}

function logWrapperEvent(event: string, details: JsonRecord): void {
  console.log(JSON.stringify({
    event,
    service: "zkpassport-verifier-container",
    ...details,
  }));
}

function logWrapperWarning(event: string, details: JsonRecord): void {
  console.warn(JSON.stringify({
    event,
    service: "zkpassport-verifier-container",
    ...details,
  }));
}

export function verifierContainerEnvVars(env: Partial<VerifierContainerEnv>): Record<string, string> {
  return {
    HOST: "0.0.0.0",
    ZKPASSPORT_VERIFIER_PORT: String(VERIFIER_PORT),
    ZKPASSPORT_VERIFIER_MAX_BODY_BYTES:
      trimEnv(env.ZKPASSPORT_VERIFIER_MAX_BODY_BYTES) || String(DEFAULT_MAX_BODY_BYTES),
    ZKPASSPORT_VERIFIER_SHARED_SECRET: trimEnv(env.ZKPASSPORT_VERIFIER_SHARED_SECRET),
    ZKPASSPORT_VERIFIER_WRITING_DIRECTORY:
      trimEnv(env.ZKPASSPORT_VERIFIER_WRITING_DIRECTORY) || "/tmp",
  };
}

export async function handleVerifierContainerRequest(
  request: Request,
  env: VerifierContainerEnv,
  proxyToVerifierContainer: VerifierContainerProxy,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({
      ok: true,
      service: "zkpassport-verifier-container",
      environment: env.ENVIRONMENT ?? "development",
    });
  }

  if (url.pathname === "/health/container" && request.method === "GET") {
    const authError = requireVerifierAuth(request, env);
    if (authError) return authError;
    return proxyToVerifierContainer(new Request(new URL("/health", request.url), request), env);
  }

  if (url.pathname === "/verify") {
    if (request.method !== "POST") {
      return jsonResponse({ code: "method_not_allowed", message: "Method not allowed" }, 405);
    }

    const startedAt = Date.now();
    const authError = requireVerifierAuth(request, env);
    if (authError) {
      logWrapperWarning("zkpassport.container.verify.rejected", {
        reason: authError.status === 401 ? "unauthorized" : "not_configured",
        latency_ms: Date.now() - startedAt,
      });
      return authError;
    }

    const bodySizeError = rejectOversizedBody(request, env);
    if (bodySizeError) {
      logWrapperWarning("zkpassport.container.verify.rejected", {
        reason: "payload_too_large",
        content_length: Number(request.headers.get("content-length") ?? "0"),
        latency_ms: Date.now() - startedAt,
      });
      return bodySizeError;
    }

    logWrapperEvent("zkpassport.container.verify.forwarded", {
      environment: env.ENVIRONMENT ?? "development",
      container_instances: containerInstanceCount(env),
      content_length: Number(request.headers.get("content-length") ?? "0") || null,
    });
    return proxyToVerifierContainer(request, env);
  }

  return jsonResponse({ code: "not_found", message: "Not found" }, 404);
}
