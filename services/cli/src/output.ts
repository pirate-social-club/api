import { PirateHttpError } from "./http.js"

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function printText(value: string): void {
  process.stdout.write(`${value}\n`)
}

export function exitWithUsage(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

export function handleFatal(error: unknown): never {
  if (error instanceof PirateHttpError) {
    process.stderr.write(`HTTP ${error.status}\n`)
    if (error.body) {
      process.stderr.write(`${JSON.stringify(error.body, null, 2)}\n`)
    } else {
      process.stderr.write(`${error.message}\n`)
    }
    process.exit(1)
  }

  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }

  process.stderr.write("Unknown error\n")
  process.exit(1)
}
