import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { setClawkeyProviderForTests } from "../../../src/lib/agents/clawkey-provider"
import { setSelfProviderForTests } from "../../../src/lib/verification/self-provider"
import {
  buildTestEnv,
  buildVerifiedSelfProvider,
  createRouteTestContext,
  json,
  resetRuntimeCaches,
} from "../../helpers"
import { createSignedAgentChallenge } from "../../agent-test-helpers"
import { createSelfVerifiedSession, exchangeJwt, requestJson } from "../verification/verification-test-helpers"

const ADMIN_TOKEN = "test-admin-token-abc123"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
  setSelfProviderForTests(buildVerifiedSelfProvider("self-agent-route-test-ref"))
})

afterEach(async () => {
  setClawkeyProviderForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("agent routes", () => {
  test("agent ownership session start requires authentication", async () => {
    const env = buildTestEnv()
    const challenge = createSignedAgentChallenge({ message: "agent-challenge-auth-required" })
    const response = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      agent_challenge: challenge.challenge,
    }, env)

    expect(response.status).toBe(401)
    const body = await json(response) as { code: string }
    expect(body.code).toBe("auth_error")
  })

  test("agent ownership requires a verified human owner", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "agent-unverified-user")
    const challenge = createSignedAgentChallenge({ message: "agent-challenge-unverified-owner" })

    const response = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Palm Agent",
      agent_challenge: challenge.challenge,
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(403)
    const body = await json(response) as { code: string }
    expect(body.code).toBe("verification_required")
  })

  test("agent ownership rejects an invalid agent challenge signature", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "agent-invalid-challenge-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const challenge = createSignedAgentChallenge({ message: "agent-invalid-challenge" })
    const response = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Broken Agent",
      agent_challenge: {
        ...challenge.challenge,
        signature: "invalid-signature",
      },
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(400)
    const body = await json(response) as { code: string; message: string }
    expect(body.code).toBe("bad_request")
    expect(body.message).toContain("agent_challenge signature is invalid")
  })

  test("verified owner can create a pairing code, claim it without bearer auth, and complete via connection token", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "agent-pairing-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_pairing_123",
        registrationUrl: "https://clawkey.test/register/cks_pairing_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-pairing",
        publicKey: null,
        registeredAt: "2026-04-19T12:34:56.000Z",
      }),
    })

    const pairingCreateResponse = await requestJson(
      "http://pirate.test/agent-ownership-pairing",
      {},
      ctx.env,
      session.accessToken,
    )
    expect(pairingCreateResponse.status).toBe(201)
    const pairingCreateBody = await json(pairingCreateResponse) as {
      pairing_code: string
      expires_at: string
    }
    expect(pairingCreateBody.pairing_code).toMatch(/^PIR-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(typeof pairingCreateBody.expires_at).toBe("string")

    const pairingChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000200",
      deviceId: "claw-device-pairing",
    })

    const pairingClaimResponse = await requestJson(
      "http://pirate.test/agent-ownership-pairing/claim",
      {
        pairing_code: pairingCreateBody.pairing_code,
        agent_challenge: pairingChallenge.challenge,
      },
      ctx.env,
    )
    expect(pairingClaimResponse.status).toBe(200)
    const pairingClaimBody = await json(pairingClaimResponse) as {
      agent_ownership_session_id: string
      registration_url: string
      connection_token: string
    }
    expect(pairingClaimBody.registration_url).toBe("https://clawkey.test/register/cks_pairing_123")
    expect(pairingClaimBody.connection_token).toMatch(/^agpair_/)

    const pairingCompleteResponse = await app.request(
      `http://pirate.test/agent-ownership-sessions/aos_${pairingClaimBody.agent_ownership_session_id}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-connection-token": pairingClaimBody.connection_token,
        },
        body: JSON.stringify({}),
      },
      ctx.env,
    )
    expect(pairingCompleteResponse.status).toBe(200)
    const pairingCompleteBody = await json(pairingCompleteResponse) as {
      status: string
      agent_id: string | null
      resolved_agent_ownership_record_id: string | null
    }
    expect(pairingCompleteBody.status).toBe("verified")
    expect(typeof pairingCompleteBody.agent_id).toBe("string")
    expect(typeof pairingCompleteBody.resolved_agent_ownership_record_id).toBe("string")
  })

  test("verified owner can register an agent through clawkey and then read it back", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "agent-owner-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const registeredAt = "2026-04-19T12:34:56.000Z"
    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_agent_123",
        registrationUrl: "https://clawkey.test/register/cks_agent_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-verified",
        publicKey: null,
        registeredAt,
      }),
    })

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000000",
      deviceId: "claw-device-verified",
    })

    const createdResponse = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Palm Agent",
      policy_id: "agent_kya_v0",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, session.accessToken)

    expect(createdResponse.status).toBe(201)
    const createdBody = await json(createdResponse) as {
      agent_ownership_session_id: string
      ownership_provider: string
      status: string
      launch: {
        mode: string
        clawkey_registration?: {
          session_id: string
          registration_url: string
          expires_at?: string | null
        }
      }
    }
    expect(createdBody.ownership_provider).toBe("clawkey")
    expect(createdBody.status).toBe("awaiting_owner")
    expect(createdBody.launch.mode).toBe("registration_url")
    expect(createdBody.launch.clawkey_registration?.session_id).toBe("cks_agent_123")
    expect(createdBody.launch.clawkey_registration?.registration_url).toBe("https://clawkey.test/register/cks_agent_123")

    const fetchedSessionResponse = await app.request(
      `http://pirate.test/agent-ownership-sessions/aos_${createdBody.agent_ownership_session_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedSessionResponse.status).toBe(200)

    const completedResponse = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${createdBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )

    expect(completedResponse.status).toBe(200)
    const completedBody = await json(completedResponse) as {
      status: string
      agent_id: string | null
      resolved_agent_ownership_record_id: string | null
    }
    expect(completedBody.status).toBe("verified")
    expect(typeof completedBody.agent_id).toBe("string")
    expect(typeof completedBody.resolved_agent_ownership_record_id).toBe("string")

    const agentsResponse = await app.request(
      "http://pirate.test/agents",
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(agentsResponse.status).toBe(200)
    const agentsBody = await json(agentsResponse) as {
      items: Array<{
        agent_id: string
        display_name: string
        handle: { label_display: string } | null
        current_ownership_record_id: string | null
        current_ownership: { ownership_provider: string; public_key: string | null } | null
      }>
    }
    expect(agentsBody.items).toHaveLength(1)
    expect(agentsBody.items[0]?.agent_id).toBe(completedBody.agent_id)
    expect(agentsBody.items[0]?.display_name).toBe("Palm Agent")
    expect(agentsBody.items[0]?.handle?.label_display).toBe("palm-agent.clawitzer")
    expect(agentsBody.items[0]?.current_ownership_record_id).toBe(completedBody.resolved_agent_ownership_record_id)
    expect(agentsBody.items[0]?.current_ownership?.ownership_provider).toBe("clawkey")
    expect(agentsBody.items[0]?.current_ownership?.public_key?.trim()).toBe(registerChallenge.publicKeyPem.trim())

    const agentResponse = await app.request(
      `http://pirate.test/agents/${completedBody.agent_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(agentResponse.status).toBe(200)
    const agentBody = await json(agentResponse) as {
      agent_id: string
      display_name: string
      handle: { label_display: string } | null
      current_ownership: { device_id: string | null; evidence_ref: string | null } | null
    }
    expect(agentBody.agent_id).toBe(completedBody.agent_id)
    expect(agentBody.display_name).toBe("Palm Agent")
    expect(agentBody.handle?.label_display).toBe("palm-agent.clawitzer")
    expect(agentBody.current_ownership?.device_id).toBe("claw-device-verified")
    expect(agentBody.current_ownership?.evidence_ref).toBe(registeredAt)

    const handleResponse = await app.request(
      `http://pirate.test/agents/${completedBody.agent_id}/handle`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(handleResponse.status).toBe(200)
    const handleBody = await json(handleResponse) as {
      agent_id: string
      label_display: string
      status: string
    }
    expect(handleBody.agent_id).toBe(completedBody.agent_id)
    expect(handleBody.label_display).toBe("palm-agent.clawitzer")
    expect(handleBody.status).toBe("active")

    const claimedHandleResponse = await app.request(
      `http://pirate.test/agents/${completedBody.agent_id}/handle`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ desired_label: "night-signal" }),
      },
      ctx.env,
    )
    expect(claimedHandleResponse.status).toBe(200)
    const claimedHandleBody = await json(claimedHandleResponse) as {
      label_display: string
      status: string
    }
    expect(claimedHandleBody.label_display).toBe("night-signal.clawitzer")
    expect(claimedHandleBody.status).toBe("active")

    const linkedHandleAt = "2026-04-19T12:45:00.000Z"
    await ctx.client.execute({
      sql: `
        INSERT INTO linked_handles (
          linked_handle_id,
          user_id,
          wallet_attachment_id,
          kind,
          label_normalized,
          label_display,
          verification_state,
          metadata_json,
          created_at,
          updated_at
        ) VALUES (?1, ?2, NULL, 'ens', ?3, ?4, 'verified', ?5, ?6, ?6)
      `,
      args: [
        "lnk_agent_owner_ens",
        session.userId,
        "agentowner.eth",
        "agentowner.eth",
        JSON.stringify({ source: "test" }),
        linkedHandleAt,
      ],
    })
    await ctx.client.execute({
      sql: `
        UPDATE profiles
        SET primary_linked_handle_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [session.userId, "lnk_agent_owner_ens", linkedHandleAt],
    })

    const publicAgentResponse = await app.request("http://pirate.test/public-agents/night-signal", {}, ctx.env)
    expect(publicAgentResponse.status).toBe(200)
    const publicAgentBody = await json(publicAgentResponse) as {
      is_canonical: boolean
      resolved_handle_label: string
      agent: { agent: string; handle: { label_display: string } }
      owner: { global_handle: { label: string }; primary_public_handle: { label: string } | null }
    }
    expect(publicAgentBody.is_canonical).toBe(true)
    expect(publicAgentBody.resolved_handle_label).toBe("night-signal.clawitzer")
    expect(publicAgentBody.agent.agent).toBe(completedBody.agent_id)
    expect(publicAgentBody.agent.handle.label_display).toBe("night-signal.clawitzer")
    expect(publicAgentBody.owner.global_handle.label).toMatch(/\.pirate$/)
    expect(publicAgentBody.owner.primary_public_handle?.label).toBe("agentowner.eth")

    const redirectedPublicAgentResponse = await app.request("http://pirate.test/public-agents/palm-agent", {}, ctx.env)
    expect(redirectedPublicAgentResponse.status).toBe(200)
    const redirectedPublicAgentBody = await json(redirectedPublicAgentResponse) as {
      is_canonical: boolean
      requested_handle_label: string
      resolved_handle_label: string
    }
    expect(redirectedPublicAgentBody.is_canonical).toBe(false)
    expect(redirectedPublicAgentBody.requested_handle_label).toBe("palm-agent.clawitzer")
    expect(redirectedPublicAgentBody.resolved_handle_label).toBe("night-signal.clawitzer")
  })

  test("verified owner can rename an agent", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "agent-rename-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_agent_rename_123",
        registrationUrl: "https://clawkey.test/register/cks_agent_rename_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-rename",
        publicKey: null,
        registeredAt: "2026-04-19T12:34:56.000Z",
      }),
    })

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000400",
      deviceId: "claw-device-rename",
    })

    const createdResponse = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Palm Agent",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, session.accessToken)
    expect(createdResponse.status).toBe(201)
    const createdBody = await json(createdResponse) as {
      agent_ownership_session_id: string
    }

    const completedResponse = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${createdBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    expect(completedResponse.status).toBe(200)
    const completedBody = await json(completedResponse) as {
      agent_id: string
    }

    const updatedResponse = await app.request(
      `http://pirate.test/agents/${completedBody.agent_id}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ display_name: "Night Signal" }),
      },
      ctx.env,
    )
    expect(updatedResponse.status).toBe(200)
    const updatedBody = await json(updatedResponse) as {
      agent_id: string
      display_name: string
    }
    expect(updatedBody.agent_id).toBe(completedBody.agent_id)
    expect(updatedBody.display_name).toBe("Night Signal")
  })

  test("admin token can list a user's agents and claim a clawitzer handle", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "agent-admin-route-owner")
    await createSelfVerifiedSession(ctx.env, ownerSession.accessToken)

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_agent_admin_route_123",
        registrationUrl: "https://clawkey.test/register/cks_agent_admin_route_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-admin-route",
        publicKey: null,
        registeredAt: "2026-04-19T12:34:56.000Z",
      }),
    })

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000500",
      deviceId: "claw-device-admin-route",
    })

    const createdResponse = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Palm Agent",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, ownerSession.accessToken)
    expect(createdResponse.status).toBe(201)
    const createdBody = await json(createdResponse) as {
      agent_ownership_session_id: string
    }

    const completedResponse = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${createdBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      ownerSession.accessToken,
    )
    expect(completedResponse.status).toBe(200)
    const completedBody = await json(completedResponse) as {
      agent_id: string
    }

    const agentsResponse = await app.request(
      "http://pirate.test/agents",
      {
        headers: {
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": ownerSession.userId,
        },
      },
      ctx.env,
    )
    expect(agentsResponse.status).toBe(200)
    const agentsBody = await json(agentsResponse) as {
      items: Array<{
        agent_id: string
        display_name: string
        handle: { label_display: string } | null
      }>
    }
    expect(agentsBody.items).toHaveLength(1)
    expect(agentsBody.items[0]?.agent_id).toBe(completedBody.agent_id)
    expect(agentsBody.items[0]?.display_name).toBe("Palm Agent")
    expect(agentsBody.items[0]?.handle?.label_display).toBe("palm-agent.clawitzer")

    const claimResponse = await app.request(
      `http://pirate.test/agents/${completedBody.agent_id}/handle`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": ownerSession.userId,
        },
        body: JSON.stringify({ desired_label: "night-signal" }),
      },
      ctx.env,
    )
    expect(claimResponse.status).toBe(200)
    const claimBody = await json(claimResponse) as {
      label_display: string
      status: string
    }
    expect(claimBody.label_display).toBe("night-signal.clawitzer")
    expect(claimBody.status).toBe("active")

    const handleResponse = await app.request(
      `http://pirate.test/agents/${completedBody.agent_id}/handle`,
      {
        headers: {
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": ownerSession.userId,
        },
      },
      ctx.env,
    )
    expect(handleResponse.status).toBe(200)
    const handleBody = await json(handleResponse) as {
      label_display: string
    }
    expect(handleBody.label_display).toBe("night-signal.clawitzer")
  })

  test("agent list is bounded and cursor paginated", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "agent-list-pagination-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)
    const userId = `usr_${session.userId.replace(/^usr_/, "")}`
    await ctx.client.execute({
      sql: `
        INSERT INTO user_agents (agent_id, owner_user_id, display_name, status, created_at, updated_at)
        VALUES
          (?1, ?2, ?3, 'active', ?4, ?4),
          (?5, ?2, ?6, 'active', ?7, ?7),
          (?8, ?2, ?9, 'active', ?10, ?10)
      `,
      args: [
        "agt_old",
        userId,
        "Old Agent",
        "2026-04-18T12:00:00.000Z",
        "agt_middle",
        "Middle Agent",
        "2026-04-19T12:00:00.000Z",
        "agt_new",
        "New Agent",
        "2026-04-20T12:00:00.000Z",
      ],
    })

    const firstPage = await app.request("http://pirate.test/agents?limit=2", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(firstPage.status).toBe(200)
    const firstBody = await json(firstPage) as {
      items: Array<{ agent_id: string }>
      next_cursor: string | null
    }
    expect(firstBody.items.map((agent) => agent.agent_id)).toEqual(["agt_new", "agt_middle"])
    expect(typeof firstBody.next_cursor).toBe("string")

    const secondPage = await app.request(
      `http://pirate.test/agents?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor ?? "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(secondPage.status).toBe(200)
    const secondBody = await json(secondPage) as {
      items: Array<{ agent_id: string }>
      next_cursor: string | null
    }
    expect(secondBody.items.map((agent) => agent.agent_id)).toEqual(["agt_old"])
    expect(secondBody.next_cursor).toBeNull()
  })

  test("admin token can seed a prod-style clawitzer agent without bearer auth", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "agent-admin-seed-owner")

    const seedResponse = await app.request(
      "http://pirate.test/agents/admin/seed",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": ownerSession.userId,
        },
        body: JSON.stringify({
          display_name: "Night Signal",
          desired_label: "night-signal",
        }),
      },
      ctx.env,
    )
    expect(seedResponse.status).toBe(201)
    const seedBody = await json(seedResponse) as {
      agent_id: string
      owner_user_id: string
      display_name: string
      handle: { label_display: string } | null
      current_ownership_record_id: string | null
    }
    expect(seedBody.owner_user_id).toBe(ownerSession.userId)
    expect(seedBody.display_name).toBe("Night Signal")
    expect(seedBody.handle?.label_display).toBe("night-signal.clawitzer")
    expect(seedBody.current_ownership_record_id).toBeNull()

    const publicAgentResponse = await app.request("http://pirate.test/public-agents/night-signal", {}, ctx.env)
    expect(publicAgentResponse.status).toBe(200)
    const publicAgentBody = await json(publicAgentResponse) as {
      is_canonical: boolean
      resolved_handle_label: string
      agent: { agent: string; display_name: string | null; ownership_provider: string | null }
      owner: { user: string; global_handle: { label: string } }
    }
    expect(publicAgentBody.is_canonical).toBe(true)
    expect(publicAgentBody.resolved_handle_label).toBe("night-signal.clawitzer")
    expect(publicAgentBody.agent.agent).toBe(seedBody.agent_id)
    expect(publicAgentBody.agent.display_name).toBe("Night Signal")
    expect(publicAgentBody.agent.ownership_provider).toBeNull()
    expect(publicAgentBody.owner.user).toBe(`usr_${ownerSession.userId}`)
    expect(publicAgentBody.owner.global_handle.label).toMatch(/\.pirate$/)
  })

  test("generic agent names fall back to the owner's primary public handle", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "agent-generic-name-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)
    await ctx.client.execute({
      sql: `
        INSERT INTO linked_handles (
          linked_handle_id,
          user_id,
          wallet_attachment_id,
          kind,
          label_normalized,
          label_display,
          verification_state,
          metadata_json,
          created_at,
          updated_at
        ) VALUES ('lnk_agent_generic_owner_ens', ?1, NULL, 'ens', 'agentgeneric.eth', 'agentgeneric.eth', 'verified', '{}', ?2, ?2)
      `,
      args: [session.userId, "2026-04-19T12:50:00.000Z"],
    })
    await ctx.client.execute({
      sql: `
        UPDATE profiles
        SET primary_linked_handle_id = 'lnk_agent_generic_owner_ens',
            updated_at = ?2
        WHERE user_id = ?1
      `,
      args: [session.userId, "2026-04-19T12:50:00.000Z"],
    })

    const meResponse = await app.request(
      "http://pirate.test/profiles/me",
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(meResponse.status).toBe(200)
    const meBody = await json(meResponse) as {
      primary_public_handle: { label: string } | null
      global_handle: { label: string }
    }
    expect(meBody.primary_public_handle?.label).toBe("agentgeneric.eth")
    const expectedDisplayName = `${meBody.primary_public_handle?.label} Agent`

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_agent_generic_name_123",
        registrationUrl: "https://clawkey.test/register/cks_agent_generic_name_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-generic-name",
        publicKey: null,
        registeredAt: "2026-04-19T12:34:56.000Z",
      }),
    })

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000300",
      deviceId: "claw-device-generic-name",
    })

    const createdResponse = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "OpenClaw Agent",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, session.accessToken)
    expect(createdResponse.status).toBe(201)
    const createdBody = await json(createdResponse) as {
      agent_ownership_session_id: string
    }

    const completedResponse = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${createdBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    expect(completedResponse.status).toBe(200)

    const agentsResponse = await app.request(
      "http://pirate.test/agents",
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(agentsResponse.status).toBe(200)
    const agentsBody = await json(agentsResponse) as {
      items: Array<{ display_name: string }>
    }
    expect(agentsBody.items[0]?.display_name).toBe(expectedDisplayName)
  })

  test("verified owner can issue and refresh a delegated credential for an active agent", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "agent-credential-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_agent_credential_123",
        registrationUrl: "https://clawkey.test/register/cks_agent_credential_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-credential",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const credentialChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000100",
      deviceId: "claw-device-credential",
    })

    const ownershipResponse = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Credential Agent",
      agent_challenge: credentialChallenge.challenge,
    }, ctx.env, session.accessToken)

    expect(ownershipResponse.status).toBe(201)
    const ownershipBody = await json(ownershipResponse) as {
      agent_ownership_session_id: string
    }

    const completeResponse = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${ownershipBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    expect(completeResponse.status).toBe(200)
    const completedBody = await json(completeResponse) as {
      agent_id: string
      resolved_agent_ownership_record_id: string
    }

    const issueResponse = await requestJson(
      `http://pirate.test/agents/${completedBody.agent_id}/credential`,
      {
        current_ownership_record_id: completedBody.resolved_agent_ownership_record_id,
      },
      ctx.env,
      session.accessToken,
    )
    expect(issueResponse.status).toBe(200)
    const issueBody = await json(issueResponse) as {
      agent: string
      owner_user: string
      current_ownership_record: string
      token_type: string
      access_token: string
      refresh_token: string
      issued_at: string
      expires_at: string
      refresh_expires_at: string | null
    }
    expect(issueBody.agent).toBe(`agt_${completedBody.agent_id}`)
    expect(issueBody.owner_user).toBe(`usr_${session.userId}`)
    expect(issueBody.current_ownership_record).toBe(`aor_${completedBody.resolved_agent_ownership_record_id}`)
    expect(issueBody.token_type).toBe("Bearer")
    expect(issueBody.access_token).toMatch(/^agtok_/)
    expect(issueBody.refresh_token).toMatch(/^agrf_/)
    expect(typeof issueBody.issued_at).toBe("number")
    expect(typeof issueBody.expires_at).toBe("number")
    expect(typeof issueBody.refresh_expires_at).toBe("number")

    const refreshResponse = await requestJson(
      `http://pirate.test/agents/${completedBody.agent_id}/refresh-credential`,
      {
        refresh_token: issueBody.refresh_token,
      },
      ctx.env,
      session.accessToken,
    )
    expect(refreshResponse.status).toBe(200)
    const refreshBody = await json(refreshResponse) as {
      agent: string
      current_ownership_record: string
      access_token: string
      refresh_token: string
    }
    expect(refreshBody.agent).toBe(`agt_${completedBody.agent_id}`)
    expect(refreshBody.current_ownership_record).toBe(`aor_${completedBody.resolved_agent_ownership_record_id}`)
    expect(refreshBody.access_token).toMatch(/^agtok_/)
    expect(refreshBody.refresh_token).toMatch(/^agrf_/)
    expect(refreshBody.access_token).not.toBe(issueBody.access_token)
    expect(refreshBody.refresh_token).not.toBe(issueBody.refresh_token)
  })

  test("verified pairing connection can issue and refresh a delegated credential without bearer auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "agent-connection-credential-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_connection_credential_123",
        registrationUrl: "https://clawkey.test/register/cks_connection_credential_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-connection-credential",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const pairingCreateResponse = await requestJson(
      "http://pirate.test/agent-ownership-pairing",
      {},
      ctx.env,
      session.accessToken,
    )
    expect(pairingCreateResponse.status).toBe(201)
    const pairingCreateBody = await json(pairingCreateResponse) as { pairing_code: string }

    const pairingChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000300",
      deviceId: "claw-device-connection-credential",
    })

    const pairingClaimResponse = await requestJson(
      "http://pirate.test/agent-ownership-pairing/claim",
      {
        pairing_code: pairingCreateBody.pairing_code,
        agent_challenge: pairingChallenge.challenge,
      },
      ctx.env,
    )
    expect(pairingClaimResponse.status).toBe(200)
    const pairingClaimBody = await json(pairingClaimResponse) as {
      agent_ownership_session_id: string
      connection_token: string
    }

    const pairingCompleteResponse = await app.request(
      `http://pirate.test/agent-ownership-sessions/aos_${pairingClaimBody.agent_ownership_session_id}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-connection-token": pairingClaimBody.connection_token,
        },
        body: JSON.stringify({}),
      },
      ctx.env,
    )
    expect(pairingCompleteResponse.status).toBe(200)
    const pairingCompleteBody = await json(pairingCompleteResponse) as {
      agent_id: string
      resolved_agent_ownership_record_id: string
    }

    const issueResponse = await app.request(
      `http://pirate.test/agents/${pairingCompleteBody.agent_id}/credential`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-connection-token": pairingClaimBody.connection_token,
        },
        body: JSON.stringify({
          current_ownership_record_id: pairingCompleteBody.resolved_agent_ownership_record_id,
        }),
      },
      ctx.env,
    )
    expect(issueResponse.status).toBe(200)
    const issueBody = await json(issueResponse) as {
      access_token: string
      refresh_token: string
    }
    expect(issueBody.access_token).toMatch(/^agtok_/)
    expect(issueBody.refresh_token).toMatch(/^agrf_/)

    const refreshResponse = await app.request(
      `http://pirate.test/agents/${pairingCompleteBody.agent_id}/refresh-credential`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-connection-token": pairingClaimBody.connection_token,
        },
        body: JSON.stringify({
          refresh_token: issueBody.refresh_token,
        }),
      },
      ctx.env,
    )
    expect(refreshResponse.status).toBe(200)
    const refreshBody = await json(refreshResponse) as {
      access_token: string
      refresh_token: string
    }
    expect(refreshBody.access_token).toMatch(/^agtok_/)
    expect(refreshBody.refresh_token).toMatch(/^agrf_/)
    expect(refreshBody.access_token).not.toBe(issueBody.access_token)
    expect(refreshBody.refresh_token).not.toBe(issueBody.refresh_token)
  })

  test("verified owner cannot register a second active agent in public v0", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "agent-single-cap-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_single_cap_123",
        registrationUrl: "https://clawkey.test/register/cks_single_cap_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-first",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const firstChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000200",
      deviceId: "claw-device-first",
    })

    const firstStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "First Agent",
      agent_challenge: firstChallenge.challenge,
    }, ctx.env, session.accessToken)
    expect(firstStart.status).toBe(201)
    const firstBody = await json(firstStart) as {
      agent_ownership_session_id: string
    }

    const firstComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${firstBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    expect(firstComplete.status).toBe(200)

    const secondChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000300",
      deviceId: "claw-device-second",
    })
    const secondStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Second Agent",
      agent_challenge: secondChallenge.challenge,
    }, ctx.env, session.accessToken)

    expect(secondStart.status).toBe(409)
    const secondBody = await json(secondStart) as { code: string; message: string }
    expect(secondBody.code).toBe("conflict")
    expect(secondBody.message).toContain("one active user-owned agent")
  })

  test("verified owner can register a new agent after the prior agent is no longer active", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "agent-single-cap-reset-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    setClawkeyProviderForTests({
      startRegistration: async ({ deviceId }) => ({
        sessionId: `cks_${deviceId}`,
        registrationUrl: `https://clawkey.test/register/${deviceId}`,
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async ({ sessionId }) => ({
        status: "completed",
        deviceId: sessionId.replace(/^cks_/, ""),
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const originalChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000400",
      deviceId: "claw-device-original",
    })

    const firstStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Original Agent",
      agent_challenge: originalChallenge.challenge,
    }, ctx.env, session.accessToken)
    expect(firstStart.status).toBe(201)
    const firstBody = await json(firstStart) as {
      agent_ownership_session_id: string
    }

    const firstComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${firstBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    expect(firstComplete.status).toBe(200)
    const firstCompleteBody = await json(firstComplete) as {
      agent_id: string
    }

    await ctx.client.execute({
      sql: `
        UPDATE user_agents
        SET status = 'deregistered', updated_at = ?2
        WHERE agent_id = ?1
      `,
      args: [firstCompleteBody.agent_id, new Date().toISOString()],
    })

    const replacementChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000500",
      deviceId: "claw-device-replacement",
    })
    const secondStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Replacement Agent",
      agent_challenge: replacementChallenge.challenge,
    }, ctx.env, session.accessToken)

    expect(secondStart.status).toBe(201)
  })

  test("agent ownership callback is not implemented for clawkey sessions", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "agent-callback-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_callback_123",
        registrationUrl: "https://clawkey.test/register/cks_callback_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({ status: "pending" }),
    })

    const callbackChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000600",
      deviceId: "claw-device-callback",
    })

    const startResponse = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Callback Agent",
      agent_challenge: callbackChallenge.challenge,
    }, ctx.env, session.accessToken)
    expect(startResponse.status).toBe(201)
    const startBody = await json(startResponse) as {
      agent_ownership_session_id: string
    }

    const callbackResponse = await app.request(
      `http://pirate.test/agent-ownership-sessions/aos_${startBody.agent_ownership_session_id}/receive-callback`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-very-callback-secret": "callback-secret",
        },
        body: JSON.stringify({
          provider: "clawkey",
          payload: {
            session_id: "cks_callback_123",
          },
        }),
      },
      ctx.env,
    )

    expect(callbackResponse.status).toBe(501)
    const callbackBody = await json(callbackResponse) as { code: string; message: string }
    expect(callbackBody.code).toBe("not_implemented")
    expect(callbackBody.message).toContain("polling completion")
  })

  test("agent ownership callback rejects missing callback secret", async () => {
    const response = await app.request(
      "http://pirate.test/agent-ownership-sessions/aos_missing_secret/receive-callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "clawkey",
          payload: {
            session_id: "cks_missing_secret",
          },
        }),
      },
      buildTestEnv(),
    )

    expect(response.status).toBe(401)
    const body = await json(response) as { code: string; message: string }
    expect(body.code).toBe("auth_error")
    expect(body.message).toBe("Callback secret is required")
  })
})
