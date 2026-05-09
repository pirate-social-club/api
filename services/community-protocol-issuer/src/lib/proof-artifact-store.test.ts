import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FileProofArtifactStore, MemoryProofArtifactStore } from "./proof-artifact-store.js";

describe("proof artifact stores", () => {
  test("stores and retrieves memory artifacts", async () => {
    const store = new MemoryProofArtifactStore();
    const ref = await store.putBase64({
      kind: "proof_input",
      batchId: "pib_test",
      valueBase64: "AQID",
    });

    expect(ref).toStartWith("memory://pib_test/proof_input/");
    await expect(store.getBase64(ref)).resolves.toBe("AQID");
  });

  test("stores and retrieves file artifacts durably", async () => {
    const dir = await mkdtemp(join(tmpdir(), "community-protocol-issuer-"));
    try {
      const store = new FileProofArtifactStore(dir);
      const ref = await store.putBase64({
        kind: "proof_receipt",
        batchId: "pib:test/unsafe",
        valueBase64: "BAUG",
      });
      const reopened = new FileProofArtifactStore(dir);

      expect(ref).toStartWith("file-artifact://");
      expect(decodeURIComponent(ref.slice("file-artifact://".length))).not.toStartWith("/");
      await expect(reopened.getBase64(ref)).resolves.toBe("BAUG");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
