#!/usr/bin/env bun

const VERSION = "0.1.0"

function usage(): string {
  return `Usage:
  pirate-agent-connector mcp

Commands:
  mcp        Start the local Pirate connector MCP server.

Options:
  --help, -h       Show this help.
  --version        Print version.

Environment:
  PIRATE_API_ORIGIN   Default Pirate API origin for MCP tool calls.
  PORT                Local MCP HTTP port. Defaults to 8797.
`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage())
    return
  }
  if (args.includes("--version")) {
    console.log(`pirate-agent-connector ${VERSION}`)
    return
  }
  const [command] = args
  if (command === "mcp") {
    await import("./local-mcp-server")
    return
  }
  throw new Error(`${usage()}\nUnknown or missing command.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
