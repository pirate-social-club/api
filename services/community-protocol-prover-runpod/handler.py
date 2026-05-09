import runpod

from proof_worker import handle_proof_job


def handler(job):
    return handle_proof_job(job)


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
