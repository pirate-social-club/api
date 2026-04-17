import { badRequestError } from "../lib/errors"

export async function parseMediaUploadForm<TKind extends string>(input: {
  req: { formData(): Promise<FormData> }
  allowedKinds: readonly TKind[]
  invalidPayloadMessage: string
  invalidKindMessage: string
}): Promise<{ file: File; kind: TKind }> {
  const formData = await input.req.formData().catch(() => null)
  if (!formData) {
    throw badRequestError(input.invalidPayloadMessage)
  }

  const kindValue = typeof formData.get("kind") === "string"
    ? String(formData.get("kind")).trim()
    : ""
  const kind = input.allowedKinds.find((candidate) => candidate === kindValue) ?? null
  if (!kind) {
    throw badRequestError(input.invalidKindMessage)
  }

  const fileValue = formData.get("file")
  if (!(fileValue instanceof File)) {
    throw badRequestError("file is required")
  }

  return {
    file: fileValue,
    kind,
  }
}
