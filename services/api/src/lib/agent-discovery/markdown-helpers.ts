import {
  serializeLinkHeader,
  type StructuredAccessLinks,
} from "./structured-links"

type OmittedSurface = {
  surface: string
  reason: string
}

export function markdownResponse(markdown: string, links: StructuredAccessLinks): Response {
  return new Response(markdown, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      Link: serializeLinkHeader(links),
    },
  })
}

export function wantsMarkdown(request: Request, format: string | null | undefined): boolean {
  if (format === "markdown" || format === "md") {
    return true
  }
  const accept = request.headers.get("accept") ?? ""
  return accept.includes("text/markdown")
}

export function omittedSurfacesMarkdown(omittedSurfaces: OmittedSurface[]): string[] {
  if (!omittedSurfaces.length) {
    return []
  }
  return [
    "## Omitted surfaces",
    "",
    ...omittedSurfaces.map((surface) => `- ${surface.surface}: ${surface.reason}`),
    "",
  ]
}
