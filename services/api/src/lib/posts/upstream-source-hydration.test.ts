import { describe, expect, test } from "bun:test"

import { hydrateDerivativeSourcesForResponses } from "./upstream-source-hydration"
import type { Client } from "../sql-client"
import type { LocalizedPostResponse } from "../../types"

function createResponse(): LocalizedPostResponse {
  return {
    post: {
      community_id: "cmt_songs",
      post_id: "pst_remix",
      post_type: "song",
      upstream_asset_refs: ["story:ip:0x01C0D038e1BA42959b83A56e5A1c459594719297#licenseTermsId=1894"],
    },
    author_community_role: null,
    thread_snapshot: null,
    market_context: null,
    label: null,
    song_presentation: null,
    upvote_count: 0,
    downvote_count: 0,
    like_count: 0,
    comment_count: 0,
    viewer_vote: null,
    viewer_reaction_kinds: [],
    age_gate_viewer_state: null,
    resolved_locale: "en",
    translation_state: "same_language",
    machine_translated: false,
    translated_body: null,
    translated_title: null,
    translated_caption: null,
    translated_embeds: null,
    source_hash: "src",
  } as unknown as LocalizedPostResponse
}

describe("hydrateDerivativeSourcesForResponses", () => {
  test("hydrates Story IP refs into source display metadata", async () => {
    const response = createResponse()
    const client = {
      execute: async () => ({
        rows: [
          {
            asset_id: "ast_original",
            community_id: "cmt_songs",
            source_post_id: "pst_original",
            display_title: "Travel Guide",
            creator_user_id: "usr_artist",
            asset_kind: "song_audio",
            license_preset: "commercial-remix",
            commercial_rev_share_pct: 10,
            story_ip_id: "0x01C0D038e1BA42959b83A56e5A1c459594719297",
            story_license_terms_id: "1894",
          },
        ],
      }),
    } as Pick<Client, "execute"> as Client

    await hydrateDerivativeSourcesForResponses({
      client,
      communityId: "cmt_songs",
      env: {} as never,
      responses: [response],
      profileRepository: null,
    })

    expect(response.derivative_sources).toEqual([
      {
        source_ref: "story:ip:0x01C0D038e1BA42959b83A56e5A1c459594719297#licenseTermsId=1894",
        title: "Travel Guide",
        kind: "song",
        relationship_type: "remix_of",
        community: "com_cmt_songs",
        asset: "asset_ast_original",
        source_post: "post_pst_original",
        story_ip: "0x01C0D038e1BA42959b83A56e5A1c459594719297",
        story_license_terms: "1894",
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
        creator_user: "usr_usr_artist",
        creator_handle: null,
        creator_display_name: null,
      },
    ])
  })

  test("hydrates a cross-community Story song and creator from the global projection", async () => {
    const response = createResponse()
    response.post.community_id = "cmt_videos"
    response.post.post_type = "video"
    const client = { execute: async () => ({ rows: [] }) } as Pick<Client, "execute"> as Client

    await hydrateDerivativeSourcesForResponses({
      client,
      communityId: "cmt_videos",
      env: {} as never,
      responses: [response],
      profileRepository: {
        getProfileByUserId: async () => ({
          global_handle: { label: "artist.pirate" },
          primary_public_handle: null,
          display_name: "Artist",
        }),
      } as never,
    }, {
      findStoryRegisteredAssetProjectionSources: async () => [{
        asset_id: "ast_original",
        community_id: "cmt_songs",
        source_post_id: "pst_original",
        display_title: "Travel Guide",
        creator_user_id: "usr_artist",
        asset_kind: "song_audio",
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
        story_ip_id: "0x01C0D038e1BA42959b83A56e5A1c459594719297",
        story_license_terms_id: "1894",
      }],
    })

    expect(response.derivative_sources?.[0]).toMatchObject({
      title: "Travel Guide",
      relationship_type: "references_song",
      community: "com_cmt_songs",
      source_post: "post_pst_original",
      creator_handle: "artist.pirate",
      creator_display_name: "Artist",
    })
  })
})
