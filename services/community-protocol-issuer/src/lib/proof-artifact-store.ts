export type ProofArtifactKind = "proof_input" | "proof_receipt";

export type ProofArtifactStore = {
  putBase64(input: {
    kind: ProofArtifactKind;
    batchId: string;
    valueBase64: string;
  }): Promise<string>;
  getBase64(ref: string): Promise<string>;
};

export class MemoryProofArtifactStore implements ProofArtifactStore {
  private readonly values = new Map<string, string>();

  async putBase64(input: {
    kind: ProofArtifactKind;
    batchId: string;
    valueBase64: string;
  }): Promise<string> {
    const ref = `memory://${input.batchId}/${input.kind}/${crypto.randomUUID()}`;
    this.values.set(ref, input.valueBase64);
    return ref;
  }

  async getBase64(ref: string): Promise<string> {
    const value = this.values.get(ref);
    if (!value) {
      throw new Error(`Proof artifact not found: ${ref}`);
    }
    return value;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, "_");
}

type FileSystemPromisesModule = {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<unknown>;
  writeFile(path: string, value: string, options: { encoding: "utf8"; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
};

type PathModule = {
  join(...segments: string[]): string;
  resolve(...segments: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
};

function importModule<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

export class FileProofArtifactStore implements ProofArtifactStore {
  constructor(private readonly rootDir: string) {}

  async putBase64(input: {
    kind: ProofArtifactKind;
    batchId: string;
    valueBase64: string;
  }): Promise<string> {
    const fs = await importModule<FileSystemPromisesModule>("node:fs/promises");
    const path = await importModule<PathModule>("node:path");
    const batchDir = path.join(this.rootDir, safeSegment(input.batchId));
    await fs.mkdir(batchDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(batchDir, `${input.kind}-${crypto.randomUUID()}.b64`);
    await fs.writeFile(filePath, input.valueBase64, { encoding: "utf8", mode: 0o600 });
    return `file-artifact://${encodeURIComponent(path.relative(path.resolve(this.rootDir), path.resolve(filePath)))}`;
  }

  async getBase64(ref: string): Promise<string> {
    if (!ref.startsWith("file-artifact://")) {
      throw new Error(`Unsupported file artifact ref: ${ref}`);
    }
    const fs = await importModule<FileSystemPromisesModule>("node:fs/promises");
    const path = await importModule<PathModule>("node:path");
    const root = path.resolve(this.rootDir);
    const refPath = decodeURIComponent(ref.slice("file-artifact://".length));
    const artifactPath = path.resolve(root, refPath);
    const relative = path.relative(root, artifactPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Proof artifact ref is outside the configured artifact directory");
    }
    return await fs.readFile(artifactPath, "utf8");
  }
}
