declare const Bun: {
  spawn(input: {
    cmd: string[]
    cwd?: string
    env?: Record<string, string | undefined>
    stdout?: "pipe"
    stderr?: "pipe"
  }): {
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    exited: Promise<number>
  }
}
