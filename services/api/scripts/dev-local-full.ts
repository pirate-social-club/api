import { spawn, type ChildProcess } from "node:child_process"

type ManagedChild = {
  name: string
  process: ChildProcess
}

function spawnManagedChild(name: string, scriptPath: string): ManagedChild {
  const child = spawn(
    process.execPath,
    ["run", scriptPath],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  )

  return {
    name,
    process: child,
  }
}

async function waitForExit(child: ChildProcess): Promise<number> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code)
        return
      }
      resolve(signal ? 1 : 0)
    })
  })
}

async function stopChildren(children: ManagedChild[], signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  for (const child of children) {
    if (child.process.exitCode === null && !child.process.killed) {
      child.process.kill(signal)
    }
  }

  await Promise.all(children.map(async (child) => {
    try {
      await waitForExit(child.process)
    } catch {
      // Ignore shutdown races while draining child exits.
    }
  }))
}

async function main(): Promise<void> {
  const children = [
    spawnManagedChild("api", "scripts/serve-local.ts"),
    spawnManagedChild("community-job-worker", "scripts/run-community-job-worker.ts"),
  ]

  let shuttingDown = false

  const shutdown = async (signal: NodeJS.Signals, exitCode: number): Promise<never> => {
    if (!shuttingDown) {
      shuttingDown = true
      console.log(`dev:local:full shutting down (${signal})`)
      await stopChildren(children, signal)
    }
    process.exit(exitCode)
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal, 0)
    })
  }

  const firstExit = await Promise.race(children.map(async (child) => ({
    name: child.name,
    code: await waitForExit(child.process),
  })))

  if (!shuttingDown) {
    shuttingDown = true
    console.error(`dev:local:full child exited: ${firstExit.name} (code ${firstExit.code})`)
    await stopChildren(children)
  }

  process.exit(firstExit.code)
}

await main()
