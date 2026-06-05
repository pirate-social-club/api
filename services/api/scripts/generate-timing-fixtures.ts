import { spawn } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"

type Fixture = {
  path: string
  size_bytes: number
}

function readArg(name: string): string | null {
  const prefix = `${name}=`
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function printUsage(): void {
  console.log(`
Usage:
  bun run timing:fixtures
  bun run timing:fixtures --output-dir /tmp/pirate-timing-fixtures

Generates real media files for scripts/timing-submission-e2e.ts:
  4mb.wav      Synthetic 24s stereo WAV audio.
  4mb.mp4      Synthetic 8s 1280x720 MP4 video.
  poster.jpg   Synthetic 1280x720 JPEG poster.

Requires ffmpeg on PATH.
`)
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    proc.stdout.setEncoding("utf8")
    proc.stderr.setEncoding("utf8")
    proc.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    proc.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    proc.on("error", reject)
    proc.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`ffmpeg ${args.join(" ")} failed with ${exitCode}\n${stdout}\n${stderr}`))
    })
  })
}

async function fixture(path: string): Promise<Fixture> {
  const info = await stat(path)
  return {
    path,
    size_bytes: info.size,
  }
}

async function createMp4(outputPath: string): Promise<void> {
  const common = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=30:duration=8",
    "-an",
    "-movflags",
    "+faststart",
  ]
  try {
    await runFfmpeg([
      ...common,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      "4000k",
      "-maxrate",
      "4000k",
      "-bufsize",
      "8000k",
      outputPath,
    ])
  } catch (error) {
    console.warn(`[timing:fixtures] libx264 encode failed, falling back to mpeg4: ${error instanceof Error ? error.message : String(error)}`)
    await runFfmpeg([
      ...common,
      "-c:v",
      "mpeg4",
      "-q:v",
      "3",
      outputPath,
    ])
  }
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage()
    return
  }

  const outputDir = resolve(readArg("--output-dir") || "scripts/generated-fixtures")
  await mkdir(outputDir, { recursive: true })

  const wavPath = resolve(outputDir, "4mb.wav")
  const mp4Path = resolve(outputDir, "4mb.mp4")
  const posterPath = resolve(outputDir, "poster.jpg")

  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100:duration=24",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ])
  await createMp4(mp4Path)
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=1:duration=1",
    "-frames:v",
    "1",
    "-q:v",
    "2",
    posterPath,
  ])

  const fixtures = await Promise.all([
    fixture(wavPath),
    fixture(mp4Path),
    fixture(posterPath),
  ])
  console.log("[timing:fixtures] generated")
  for (const item of fixtures) {
    console.log(`${basename(item.path)}\t${item.size_bytes}\t${item.path}`)
  }
}

main().catch((error) => {
  console.error("[timing:fixtures] failed", error)
  process.exit(1)
})
