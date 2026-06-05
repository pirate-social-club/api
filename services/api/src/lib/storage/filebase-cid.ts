import { providerUnavailable } from "../errors"

function extractXmlValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return match?.[1]?.trim() || null
}

function cidFromHeader(response: Response | null | undefined): string | null {
  return response?.headers.get("x-amz-meta-cid")?.trim() || null
}

export async function readFilebaseCid(input: {
  response: Response
  headResponse?: Response | null
  readBodyXml?: boolean
  errorMessage?: string
}): Promise<string> {
  const headCid = cidFromHeader(input.headResponse)
  if (headCid) {
    return headCid
  }

  const responseCid = cidFromHeader(input.response)
  if (responseCid) {
    return responseCid
  }

  if (input.readBodyXml && !input.response.bodyUsed) {
    const xml = await input.response.text().catch(() => "")
    const xmlCid = extractXmlValue(xml, "CID")
    if (xmlCid) {
      return xmlCid
    }
  }

  throw providerUnavailable(input.errorMessage ?? "Filebase upload did not return an IPFS CID")
}
