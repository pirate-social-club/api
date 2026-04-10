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
