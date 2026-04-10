import type { ParsedArgs } from "./types.js"

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) {
      flags[key] = true
      continue
    }

    flags[key] = next
    index += 1
  }

  return { positionals, flags }
}

export function getFlag(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name]
  return typeof value === "string" ? value : null
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = getFlag(args, name)
  if (!value) {
    throw new Error(`Missing required flag --${name}`)
  }
  return value
}
