import type { LocalizedPostResponse, Post } from "../../types"

type ThreadBodyPostFields =
  | "body"
  | "caption"
  | "lyrics"
  | "media_refs"
  | "embeds"
  | "link_url"

export type ThreadBodyOmittedPostResponse = Omit<
  LocalizedPostResponse,
  "post" | "translated_body" | "translated_caption"
> & {
  post: Omit<Post, ThreadBodyPostFields>
}

export function omitThreadBody(response: LocalizedPostResponse): ThreadBodyOmittedPostResponse {
  const {
    body: _body,
    caption: _caption,
    lyrics: _lyrics,
    media_refs: _mediaRefs,
    embeds: _embeds,
    link_url: _linkUrl,
    ...post
  } = response.post
  const {
    translated_body: _translatedBody,
    translated_caption: _translatedCaption,
    ...rest
  } = response

  return {
    ...rest,
    post,
  }
}
