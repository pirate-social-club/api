import type { Env } from "../../env"
import type { Post } from "../../types"
import type { DbExecutor } from "../db-helpers"
import type { Client } from "../sql-client"
import type { SupportedEmbedTarget } from "./embed-url-detection"

export type LinkPostEmbedHydrationInput = {
  client: DbExecutor
  controlPlaneClient?: Client | null
  env?: Env
  post: Post
  checkedAt: string
  fetcher?: typeof fetch
}

export type ProviderEmbedHydrationInput<TTarget extends SupportedEmbedTarget> = {
  client: DbExecutor
  post: Post
  target: TTarget
  checkedAt: string
  fetcher: typeof fetch
}
