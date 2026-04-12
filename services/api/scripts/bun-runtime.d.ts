declare const Bun: {
  sleep(ms: number): Promise<void>
  write(path: string | URL, data: string | ArrayBufferView | ArrayBuffer): Promise<number>
  spawn(options: {
    cmd: string[]
    stdout?: "pipe" | "ignore"
    stderr?: "pipe" | "ignore"
  }): {
    exited: Promise<number>
    stderr: ReadableStream<Uint8Array> | null
  }
}
