import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export function readDevVars(filepath: string): Record<string, string> {
  if (!existsSync(filepath)) return {}

  const values: Record<string, string> = {}
  const lines = readFileSync(filepath, "utf8").split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const equalsIndex = line.indexOf("=")
    if (equalsIndex <= 0) continue

    const key = line.slice(0, equalsIndex).trim()
    let rawValue = line.slice(equalsIndex + 1)

    if (rawValue === "\"") {
      const parts: string[] = []
      while (index + 1 < lines.length) {
        index += 1
        const nextLine = lines[index]
        if (nextLine.endsWith("\"")) {
          parts.push(nextLine.slice(0, -1))
          break
        }
        parts.push(nextLine)
      }
      values[key] = parts.join("\n")
      continue
    }

    if (rawValue.startsWith("\"") && !rawValue.endsWith("\"")) {
      const parts = [rawValue.slice(1)]
      while (index + 1 < lines.length) {
        index += 1
        const nextLine = lines[index]
        if (nextLine.endsWith("\"")) {
          parts.push(nextLine.slice(0, -1))
          break
        }
        parts.push(nextLine)
      }
      values[key] = parts.join("\n")
      continue
    }

    if (rawValue.startsWith("\"") && rawValue.endsWith("\"")) {
      rawValue = rawValue.slice(1, -1)
    }

    values[key] = rawValue.trim()
  }

  return values
}

export function readDevVarsFromCwd(filename = ".dev.vars"): Record<string, string> {
  return readDevVars(resolve(process.cwd(), filename))
}

function stripJsonComments(input: string): string {
  let result = ""
  let inString = false
  let quote = "\""
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) {
        inString = false
      }
      continue
    }

    if ((char === "\"" || char === "'")) {
      inString = true
      quote = char
      result += char
      continue
    }

    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") {
        index += 1
      }
      if (index < input.length) {
        result += "\n"
      }
      continue
    }

    if (char === "/" && next === "*") {
      index += 2
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        index += 1
      }
      index += 1
      continue
    }

    result += char
  }

  return result
}

export function readWranglerVars(filepath: string, environment = "development"): Record<string, string> {
  if (!existsSync(filepath)) return {}

  const raw = readFileSync(filepath, "utf8")
  const config = JSON.parse(stripJsonComments(raw)) as {
    vars?: Record<string, unknown>
    env?: Record<string, { vars?: Record<string, unknown> }>
  }

  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.vars || {})) {
    if (value == null) continue
    resolved[key] = String(value)
  }

  const scopedEnv = config.env?.[environment]?.vars || {}
  for (const [key, value] of Object.entries(scopedEnv)) {
    if (value == null) continue
    resolved[key] = String(value)
  }

  return resolved
}

export function readWranglerVarsFromCwd(filename = "wrangler.jsonc", environment = "development"): Record<string, string> {
  return readWranglerVars(resolve(process.cwd(), filename), environment)
}
