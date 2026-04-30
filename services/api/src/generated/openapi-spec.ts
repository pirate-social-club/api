// GENERATED FILE. Run `bun run scripts/generate-openapi-spec.ts` to regenerate.
// Source: core/specs/api/openapi.yaml paths filtered through core/specs/api/openapi-implemented.yaml

const spec = {
  "openapi": "3.0.3",
  "info": {
    "title": "Pirate API",
    "version": "0.1.0",
    "description": "Contract-first API surface for Pirate v2.\nThis modular source carries the broader planned v0 design surface alongside the first executable slice.\nOperations marked `x-implemented: true` are filtered into `specs/api/openapi-implemented.yaml`, which is the strict generated surface for SDKs and other implementation-bound tooling.\n"
  },
  "servers": [
    {
      "url": "https://api.pirate.example",
      "description": "Placeholder production server"
    }
  ],
  "security": [
    {
      "bearerAuth": []
    }
  ],
  "tags": [
    {
      "name": "Agent Discovery"
    },
    {
      "name": "Auth"
    },
    {
      "name": "Verification"
    },
    {
      "name": "Agents"
    },
    {
      "name": "Onboarding"
    },
    {
      "name": "Wallets"
    },
    {
      "name": "Users"
    },
    {
      "name": "Profiles"
    },
    {
      "name": "Communities"
    },
    {
      "name": "Handles"
    },
    {
      "name": "Posts"
    },
    {
      "name": "Comments"
    },
    {
      "name": "Livestreams"
    },
    {
      "name": "Questions"
    },
    {
      "name": "Feeds"
    },
    {
      "name": "Tracks"
    },
    {
      "name": "Scrobbles"
    },
    {
      "name": "Moderation"
    },
    {
      "name": "MPP"
    },
    {
      "name": "Notifications"
    },
    {
      "name": "Jobs"
    }
  ],
  "paths": {
    "/auth/session/exchange": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Exchange an upstream auth proof for a Pirate app session",
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "proof"
                ],
                "properties": {
                  "proof": {
                    "description": "Upstream auth proof presented to Pirate. The first executable backend slice\nruns through `jwt_based_auth` so Bruno and local development can exercise\naccount creation without a browser. `privy_access_token` remains part of the\nbroader v0 product direction, and this request shape stays forward-compatible\nwith multiple upstream providers. This JWT-first path is not the intended\nlong-term human CLI login UX. A future Pirate CLI flow should use a browser\nhandoff or device-code-style session and then terminate at the same Pirate app\nsession model returned by this exchange endpoint.\n",
                    "oneOf": [
                      {
                        "type": "object",
                        "required": [
                          "type",
                          "privy_access_token"
                        ],
                        "properties": {
                          "type": {
                            "type": "string",
                            "enum": [
                              "privy_access_token"
                            ]
                          },
                          "privy_access_token": {
                            "type": "string"
                          },
                          "privy_identity_token": {
                            "type": "string",
                            "nullable": true,
                            "description": "Optional Privy identity token for the same authenticated subject.\nWhen present, Pirate may extract linked wallets directly from the\ntoken and create wallet attachments during session bootstrap. In the\nfirst Privy slice, omitting this field still authenticates the user\nbut may return an empty `wallet_attachments` array.\n"
                          },
                          "wallet_address": {
                            "type": "string",
                            "nullable": true,
                            "description": "Optional wallet-selection hint for the authenticated Privy subject.\nWhen present, Pirate must resolve it against the wallet set linked to\nthe authenticated upstream identity and use that wallet attachment for\nsession bootstrap rather than discovering the default wallet implicitly.\nThe first executable Privy slice may ignore this hint.\n"
                          }
                        }
                      },
                      {
                        "type": "object",
                        "required": [
                          "type",
                          "jwt"
                        ],
                        "properties": {
                          "type": {
                            "type": "string",
                            "enum": [
                              "jwt_based_auth"
                            ]
                          },
                          "jwt": {
                            "type": "string",
                            "description": "Signed JWT presented to Pirate for server-side verification. The server\nmust validate the JWT signature, issuer, expiration, and any configured\naudience requirements, then treat validated `iss` + `sub` as the\nupstream provider identity. In the first executable JWT slice, this\nrequest variant does not create wallet attachments and does not accept a\nwallet-selection hint. Newly created JWT-path users therefore return an\nempty `wallet_attachments` array in `SessionExchangeResponse`.\n"
                          }
                        }
                      }
                    ],
                    "discriminator": {
                      "propertyName": "type"
                    }
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Session created or resumed",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SessionExchangeResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "post_auth_session_exchange"
      }
    },
    "/verification-sessions": {
      "post": {
        "tags": [
          "Verification"
        ],
        "summary": "Start an interactive verification session",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/StartVerificationSessionRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Verification session started",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/VerificationSession"
                },
                "examples": {
                  "self_qr_launch": {
                    "summary": "Self verification session launch",
                    "value": {
                      "verification_session_id": "ver_sess_01HSELFQREXAMPLE",
                      "user_id": "usr_01HUSEREXAMPLE",
                      "provider": "self",
                      "provider_mode": "qr_deeplink",
                      "requested_capabilities": [
                        "unique_human"
                      ],
                      "status": "pending",
                      "launch": {
                        "mode": "qr_deeplink",
                        "self_app": {
                          "app_name": "Pirate",
                          "endpoint": "https://api.pirate.example/verification-sessions/ver_sess_01HSELFQREXAMPLE/callback",
                          "endpoint_type": "https",
                          "scope": "pirate-verification-v0",
                          "session_id": "ver_sess_01HSELFQREXAMPLE",
                          "user_id": "0x5a20f59b8d4df2e3c68d94e2fa4e3f9c3a0dc5cde8e0c614f8b4bc2d53a9e8b1",
                          "user_id_type": "hex",
                          "disclosures": {
                            "nationality": false,
                            "minimum_age": null,
                            "gender": false
                          }
                        }
                      },
                      "callback_path": "/verification-sessions/ver_sess_01HSELFQREXAMPLE/callback",
                      "created_at": "2026-04-10T12:00:00Z",
                      "expires_at": "2026-04-10T12:15:00Z"
                    }
                  },
                  "very_widget_launch": {
                    "summary": "Very widget verification session launch",
                    "value": {
                      "verification_session_id": "ver_sess_01HVERYWIDGETEXAMPLE",
                      "user_id": "usr_01HUSEREXAMPLE",
                      "provider": "very",
                      "provider_mode": "widget",
                      "requested_capabilities": [
                        "unique_human"
                      ],
                      "status": "pending",
                      "launch": {
                        "mode": "widget",
                        "very_widget": {
                          "app_id": "",
                          "context": "VeryAI - Palm Verification Timestamp",
                          "type_id": "3",
                          "query": {
                            "conditions": [
                              {
                                "identifier": "val",
                                "operation": "IN",
                                "value": {
                                  "from": "1743436800",
                                  "to": "2043436800"
                                }
                              }
                            ],
                            "options": {
                              "expiredAtLowerBound": "1743436800",
                              "externalNullifier": "pirate-unique-human-v0",
                              "equalCheckId": "0",
                              "pseudonym": "ver_sess_01HVERYWIDGETEXAMPLE.7f9f0e6b"
                            }
                          },
                          "verify_url": "https://verify.very.org/api/v1/verify",
                          "session_binding": {
                            "uniqueness_domain": "pirate-unique-human-v0",
                            "binding_value": "ver_sess_01HVERYWIDGETEXAMPLE.7f9f0e6b",
                            "binding_field": "pseudonym",
                            "challenge_expires_at": "2026-04-10T12:15:00Z"
                          }
                        }
                      },
                      "callback_path": "/verification-sessions/ver_sess_01HVERYWIDGETEXAMPLE/complete",
                      "created_at": "2026-04-10T12:00:00Z",
                      "expires_at": "2026-04-10T12:15:00Z"
                    }
                  }
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_verification_sessions"
      }
    },
    "/verification/wallet-score": {
      "get": {
        "tags": [
          "Verification"
        ],
        "summary": "Get the current wallet score capability",
        "description": "Read the current Human Passport-derived wallet-score capability for the authenticated user.\nThis is a server-owned score read, not an interactive verification session.\n",
        "responses": {
          "200": {
            "description": "Current wallet score capability",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/WalletScoreCapabilityState"
                },
                "example": {
                  "state": "verified",
                  "provider": "passport",
                  "proof_type": "wallet_score",
                  "mechanism": "stamps-api-v2",
                  "verified_at": "2026-04-10T12:00:00Z",
                  "score": 28.4,
                  "score_threshold": 20,
                  "passing_score": true,
                  "last_score_timestamp": "2026-04-10T11:59:30Z",
                  "expiration_timestamp": "2026-05-10T12:00:00Z",
                  "stamps": [
                    {
                      "stamp_name": "Gitcoin Passport",
                      "stamp_score": 18.4
                    },
                    {
                      "stamp_name": "ENS",
                      "stamp_score": 10
                    }
                  ]
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "get_verification_wallet_score"
      }
    },
    "/verification/passport-wallet-score": {
      "get": {
        "tags": [
          "Verification"
        ],
        "summary": "Get the current wallet score capability",
        "description": "Read the current Human Passport-derived wallet-score capability for the authenticated user.\nThis is a server-owned score read, not an interactive verification session.\n",
        "responses": {
          "200": {
            "description": "Current wallet score capability",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/WalletScoreCapabilityState"
                },
                "example": {
                  "state": "verified",
                  "provider": "passport",
                  "proof_type": "wallet_score",
                  "mechanism": "stamps-api-v2",
                  "verified_at": "2026-04-10T12:00:00Z",
                  "score": 28.4,
                  "score_threshold": 20,
                  "passing_score": true,
                  "last_score_timestamp": "2026-04-10T11:59:30Z",
                  "expiration_timestamp": "2026-05-10T12:00:00Z",
                  "stamps": [
                    {
                      "stamp_name": "Gitcoin Passport",
                      "stamp_score": 18.4
                    },
                    {
                      "stamp_name": "ENS",
                      "stamp_score": 10
                    }
                  ]
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "get_verification_passport_wallet_score"
      }
    },
    "/verification-sessions/{verification_session_id}": {
      "get": {
        "tags": [
          "Verification"
        ],
        "summary": "Inspect a verification session",
        "parameters": [
          {
            "name": "verification_session_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/VerificationSessionId"
          }
        ],
        "responses": {
          "200": {
            "description": "Verification session",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/VerificationSession"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_verification_sessions_by_verification_session_id"
      }
    },
    "/verification-sessions/{verification_session_id}/callback": {
      "post": {
        "tags": [
          "Verification"
        ],
        "summary": "Provider callback for a verification session",
        "parameters": [
          {
            "name": "verification_session_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/VerificationSessionId"
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/ProviderVerificationCallbackRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Verification session updated by provider callback",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/VerificationSession"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_verification_sessions_by_verification_session_id_callback"
      }
    },
    "/verification-sessions/{verification_session_id}/self-callback": {
      "post": {
        "tags": [
          "Verification"
        ],
        "security": [],
        "summary": "Receive a Self proof callback",
        "description": "Public callback endpoint used by Self QR/deeplink sessions. The backend verifies the SDK\nproof payload against the server-authored session config before minting capabilities.\n",
        "parameters": [
          {
            "name": "verification_session_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/VerificationSessionId"
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/ProviderVerificationCallbackRequest"
              },
              "example": {
                "provider": "self",
                "event_type": "proof_submitted",
                "attestation_id": "1",
                "payload": {
                  "attestationId": 1,
                  "proof": {},
                  "publicSignals": [],
                  "userContextData": "0x..."
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Self callback processed",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "status",
                    "verification_session_id"
                  ],
                  "properties": {
                    "status": {
                      "type": "string"
                    },
                    "verification_session_id": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_verification_sessions_by_verification_session_id_self_callback"
      }
    },
    "/verification-sessions/{verification_session_id}/complete": {
      "post": {
        "tags": [
          "Verification"
        ],
        "summary": "Complete or refresh a verification session",
        "parameters": [
          {
            "name": "verification_session_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/VerificationSessionId"
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CompleteVerificationSessionRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Verification session updated",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/VerificationSession"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_verification_sessions_by_verification_session_id_complete"
      }
    },
    "/agent-ownership-sessions": {
      "post": {
        "tags": [
          "Agents"
        ],
        "summary": "Start an agent ownership session",
        "description": "Starts a KYA-backed session for agent registration, refresh, transfer, or deregistration.\nThe request must include an agent-signed challenge proving control of the agent key or\nruntime identity before the human completes the provider verification flow. Servers may fail\nfast from `pending` when the challenge or session preconditions are invalid. `policy_id`\nselects server-side ownership-session policy and verifier configuration; it does not weaken\nplatform or community trust requirements. The mainline public provider flow is `clawkey`,\nwhich starts with `register/init` and returns a `registrationUrl` for the human owner to\nopen manually.\n",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/StartAgentOwnershipSessionRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Agent ownership session started",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentOwnershipSession"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_agent_ownership_sessions"
      }
    },
    "/agent-ownership-pairing": {
      "post": {
        "tags": [
          "Agents"
        ],
        "summary": "Create a short-lived OpenClaw pairing code",
        "description": "Creates a short-lived pairing code that lets an OpenClaw plugin bootstrap an agent ownership\nsession without the user's Pirate bearer token. The caller must already satisfy Pirate's\nhuman-verification baseline for agent ownership before a code will be issued.\n",
        "responses": {
          "201": {
            "description": "Pairing code created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentOwnershipPairing"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_agent_ownership_pairing"
      }
    },
    "/agent-ownership-pairing/claim": {
      "post": {
        "tags": [
          "Agents"
        ],
        "security": [],
        "summary": "Claim a pairing code and start a ClawKey ownership session",
        "description": "Claims a short-lived pairing code with an agent-signed challenge. The server validates the\npairing code and challenge, internally starts the ordinary ClawKey ownership-session flow,\nand returns the ClawKey registration URL plus a scoped connection token for completion\npolling.\n",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/AgentOwnershipPairingClaimRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Pairing code claimed and registration started",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentOwnershipPairingClaimResult"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_agent_ownership_pairing_claim"
      }
    },
    "/agent-ownership-sessions/{agent_ownership_session_id}": {
      "get": {
        "tags": [
          "Agents"
        ],
        "summary": "Inspect an agent ownership session",
        "parameters": [
          {
            "name": "agent_ownership_session_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/AgentOwnershipSessionId"
          }
        ],
        "responses": {
          "200": {
            "description": "Agent ownership session",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentOwnershipSession"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_agent_ownership_sessions_by_agent_ownership_session_id"
      }
    },
    "/agent-ownership-sessions/{agent_ownership_session_id}/complete": {
      "post": {
        "tags": [
          "Agents"
        ],
        "summary": "Complete or refresh an agent ownership session",
        "description": "Completes a provider flow when the provider requires an explicit finish step instead of, or\nin addition to, callback delivery. Providers may surface attestation or proof references\nhere. Calling this endpoint on an already terminal session should be treated idempotently by\nthe runtime. Mainline `clawkey` ownership is polling-first: the server should resolve the\nstored provider session ID, poll ClawKey registration status, and finalize only once the\nprovider reports completion. OpenClaw plugin polling may use a scoped connection token\nheader instead of the user's Pirate bearer auth.\n",
        "parameters": [
          {
            "name": "agent_ownership_session_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/AgentOwnershipSessionId"
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CompleteAgentOwnershipSessionRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Agent ownership session updated",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentOwnershipSession"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_agent_ownership_sessions_by_agent_ownership_session_id_complete"
      }
    },
    "/agent-ownership-sessions/{agent_ownership_session_id}/callback": {
      "post": {
        "tags": [
          "Agents"
        ],
        "security": [],
        "summary": "Receive an asynchronous provider callback for an agent ownership session",
        "description": "Publicly reachable callback endpoint for provider-driven completion. The absence of transport-\nlevel auth here does not imply trust: the runtime must authenticate the caller against the\nstored session's expected provider and reject provider/session mismatches. Duplicate callback\ndeliveries must be idempotent and must not create duplicate ownership records. Mainline\n`clawkey` ownership should be treated as polling-first; this callback surface is optional\nand should only be enabled if a provider exposes a real callback contract.\n",
        "parameters": [
          {
            "name": "agent_ownership_session_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/AgentOwnershipSessionId"
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/ProviderAgentOwnershipCallbackRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Agent ownership session updated from callback data",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentOwnershipSession"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_agent_ownership_sessions_by_agent_ownership_session_id_callback"
      }
    },
    "/agents": {
      "get": {
        "tags": [
          "Agents"
        ],
        "summary": "List the authenticated user's agents",
        "responses": {
          "200": {
            "description": "User-owned agents",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UserAgentListResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "get_agents"
      }
    },
    "/agents/{agent_id}": {
      "get": {
        "tags": [
          "Agents"
        ],
        "summary": "Get a user-owned agent",
        "parameters": [
          {
            "name": "agent_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/AgentId"
          }
        ],
        "responses": {
          "200": {
            "description": "User-owned agent",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UserAgent"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_agents_by_agent_id"
      }
    },
    "/agents/{agent_id}/handle": {
      "get": {
        "tags": [
          "Agents"
        ],
        "summary": "Get a user-owned agent handle",
        "parameters": [
          {
            "name": "agent_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/AgentId"
          }
        ],
        "responses": {
          "200": {
            "description": "Active agent handle",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentHandle"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_agents_by_agent_id_handle"
      },
      "post": {
        "tags": [
          "Agents"
        ],
        "summary": "Claim or rename a user-owned agent handle",
        "description": "Claims the canonical `.clawitzer` handle for an active user-owned agent. The authenticated\ncaller must own the agent. Existing active handles are preserved as redirects when renamed.\n",
        "parameters": [
          {
            "name": "agent_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/AgentId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdateAgentHandleRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Active agent handle",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentHandle"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_agents_by_agent_id_handle"
      }
    },
    "/agents/{agent_id}/credential": {
      "post": {
        "tags": [
          "Agents"
        ],
        "summary": "Issue a delegated credential for a user-owned agent",
        "description": "Issues an agent-scoped delegated API credential for the authenticated owner after re-checking\nowner standing, active ownership, and the applicable KYA baseline. Public v0 should prefer\nopaque bearer access tokens plus a refresh contract. Issuance must fail when the referenced\nagent is not currently backed by an active verified ownership interval for the caller.\n",
        "parameters": [
          {
            "name": "agent_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/AgentId"
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/AgentDelegatedCredentialIssueRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Delegated credential issued",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentDelegatedCredential"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_agents_by_agent_id_credential"
      }
    },
    "/agents/{agent_id}/credential/refresh": {
      "post": {
        "tags": [
          "Agents"
        ],
        "summary": "Refresh a delegated credential for a user-owned agent",
        "description": "Refreshes an existing delegated agent credential. The runtime must re-check owner standing,\nactive ownership, and KYA validity before minting a new access token. Refresh denial is the\nmain revocation chokepoint for suspended owners, expired ownership intervals, or revoked\nagents.\n",
        "parameters": [
          {
            "name": "agent_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/AgentId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/AgentDelegatedCredentialRefreshRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Delegated credential refreshed",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AgentDelegatedCredential"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/Forbidden"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_agents_by_agent_id_credential_refresh"
      }
    },
    "/public-agents/{handle_label}": {
      "get": {
        "tags": [
          "Agents"
        ],
        "security": [],
        "summary": "Resolve a public `.clawitzer` agent handle",
        "parameters": [
          {
            "name": "handle_label",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/HandleLabel"
          }
        ],
        "responses": {
          "200": {
            "description": "Public agent resolution",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PublicAgentResolution"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_public_agents_by_handle_label"
      }
    },
    "/namespace-verification-sessions": {
      "post": {
        "tags": [
          "Verification"
        ],
        "summary": "Start a namespace verification session",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/StartNamespaceVerificationSessionRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Namespace verification session started",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/NamespaceVerificationSession"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_namespace_verification_sessions"
      }
    },
    "/namespace-verification-sessions/{namespace_verification_session_id}": {
      "get": {
        "tags": [
          "Verification"
        ],
        "summary": "Inspect a namespace verification session",
        "parameters": [
          {
            "name": "namespace_verification_session_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/NamespaceVerificationSessionId"
          }
        ],
        "responses": {
          "200": {
            "description": "Namespace verification session",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/NamespaceVerificationSession"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_namespace_verification_sessions_by_namespace_verification_session_id"
      }
    },
    "/namespace-verification-sessions/{namespace_verification_session_id}/complete": {
      "post": {
        "tags": [
          "Verification"
        ],
        "summary": "Complete or refresh a namespace verification session",
        "parameters": [
          {
            "name": "namespace_verification_session_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/NamespaceVerificationSessionId"
          }
        ],
        "requestBody": {
          "required": false,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CompleteNamespaceVerificationSessionRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Namespace verification session updated",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/NamespaceVerificationSession"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_namespace_verification_sessions_by_namespace_verification_session_id_complete"
      }
    },
    "/namespace-verifications/{namespace_verification_id}": {
      "get": {
        "tags": [
          "Verification"
        ],
        "summary": "Inspect an accepted namespace verification",
        "parameters": [
          {
            "name": "namespace_verification_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/NamespaceVerificationId"
          }
        ],
        "responses": {
          "200": {
            "description": "Accepted namespace verification",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/NamespaceVerification"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_namespace_verifications_by_namespace_verification_id"
      }
    },
    "/onboarding/status": {
      "get": {
        "tags": [
          "Onboarding"
        ],
        "summary": "Fetch onboarding status for the current user",
        "responses": {
          "200": {
            "description": "Onboarding state",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/OnboardingStatus"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "get_onboarding_status"
      }
    },
    "/onboarding/dismiss": {
      "post": {
        "tags": [
          "Onboarding"
        ],
        "summary": "Dismiss onboarding for the current user",
        "responses": {
          "200": {
            "description": "Updated onboarding state",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/OnboardingStatus"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "post_onboarding_dismiss"
      }
    },
    "/onboarding/reddit-verification": {
      "post": {
        "tags": [
          "Onboarding"
        ],
        "summary": "Start or refresh Reddit ownership verification",
        "description": "Idempotent Reddit ownership verification entrypoint.\n\nRepeated `POST` requests are the intended polling/check mechanism in v0.\n\nServer behavior:\n\n- when no active verification session exists, create a new pending session, issue a verification code, and return `status = pending`\n- when an unexpired pending session exists, re-check the user's Reddit profile/about surface for the issued code and return the updated verification state\n- when the prior session expired, create a fresh pending session with a new code\n- when verification already succeeded for the same user and username, return the verified state\n\nRecommended v0 policy:\n\n- pending verification sessions expire after `15 minutes`\n- the server should track repeated checks and may surface `failure_code = rate_limited` when the caller exceeds the per-session check budget\n",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "reddit_username"
                ],
                "properties": {
                  "reddit_username": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Reddit verification state",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/RedditVerification"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_onboarding_reddit_verification"
      }
    },
    "/onboarding/reddit-imports": {
      "post": {
        "tags": [
          "Onboarding"
        ],
        "summary": "Trigger a Reddit snapshot import job",
        "description": "Queues or starts a one-time onboarding Reddit snapshot import for a previously verified Reddit username.\n\nThe server must reuse the canonical async jobs model with `job_type = reddit_snapshot_import`.\nOn success, `job.result_ref` should point at the immutable onboarding snapshot captured from the import.\n",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "reddit_username"
                ],
                "properties": {
                  "reddit_username": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "202": {
            "description": "Import job queued",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/JobAcceptedResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_onboarding_reddit_imports"
      }
    },
    "/onboarding/reddit-imports/latest": {
      "get": {
        "tags": [
          "Onboarding"
        ],
        "summary": "Fetch the latest completed Reddit onboarding import summary",
        "description": "Returns the most recent successfully imported Reddit onboarding snapshot summary for the current user.\n\nThis is the lightweight read model intended to power onboarding UI after the async import completes.\nIt should not expose raw historical post/comment archives or imply ongoing sync.\n",
        "responses": {
          "200": {
            "description": "Latest Reddit onboarding import summary",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/RedditImportSummary"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_onboarding_reddit_imports_latest"
      }
    },
    "/users/me": {
      "get": {
        "tags": [
          "Users"
        ],
        "summary": "Get the current user",
        "parameters": [
          {
            "in": "query",
            "name": "community_ref",
            "required": false,
            "schema": {
              "type": "string"
            },
            "description": "Optional community reference used to include community-specific posting state for the\ncaller. Accepts a community ID, route key, or `@namespace` label.\n"
          }
        ],
        "responses": {
          "200": {
            "description": "Current user",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/User"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "get_users_me"
      }
    },
    "/profiles/me": {
      "get": {
        "tags": [
          "Profiles"
        ],
        "summary": "Get the current user's public/editable profile",
        "responses": {
          "200": {
            "description": "Current profile",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Profile"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "get_profiles_me"
      },
      "patch": {
        "tags": [
          "Profiles"
        ],
        "summary": "Update editable profile fields",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "display_name": {
                    "type": "string"
                  },
                  "avatar_ref": {
                    "type": "string",
                    "nullable": true
                  },
                  "cover_ref": {
                    "type": "string",
                    "nullable": true
                  },
                  "bio": {
                    "type": "string",
                    "nullable": true
                  },
                  "preferred_locale": {
                    "type": "string",
                    "nullable": true
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated profile",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Profile"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "patch_profiles_me"
      }
    },
    "/profiles/me/xmtp-inbox": {
      "post": {
        "tags": [
          "Profiles"
        ],
        "summary": "Publish or rotate the current profile's XMTP inbox ID",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "xmtp_inbox_id"
                ],
                "properties": {
                  "xmtp_inbox_id": {
                    "type": "string",
                    "nullable": true,
                    "description": "Current XMTP inbox ID for this browser-local chat identity, or null to clear a stale value."
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated profile",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Profile"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "post_profiles_me_xmtp_inbox"
      }
    },
    "/profiles/me/global-handle/rename": {
      "post": {
        "tags": [
          "Profiles"
        ],
        "summary": "Rename the current active global .pirate handle",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "desired_label"
                ],
                "properties": {
                  "desired_label": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Global handle updated",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/GlobalHandle"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_profiles_me_global_handle_rename"
      }
    },
    "/profiles/me/global-handle/upgrade-quote": {
      "post": {
        "tags": [
          "Profiles"
        ],
        "summary": "Quote a paid upgrade into a cleaner .pirate handle",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "desired_label"
                ],
                "properties": {
                  "desired_label": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Upgrade quote",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/HandleUpgradeQuote"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_profiles_me_global_handle_upgrade_quote"
      }
    },
    "/profiles/me/linked-handles/sync": {
      "post": {
        "tags": [
          "Profiles"
        ],
        "summary": "Refresh wallet-derived linked handles for the current profile",
        "responses": {
          "200": {
            "description": "Updated profile",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Profile"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "post_profiles_me_linked_handles_sync"
      }
    },
    "/profiles/me/primary-public-handle": {
      "post": {
        "tags": [
          "Profiles"
        ],
        "summary": "Select the current profile's primary public handle",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "linked_handle_id": {
                    "type": "string",
                    "nullable": true
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Updated profile",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Profile"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_profiles_me_primary_public_handle"
      }
    },
    "/profiles/{user_id}": {
      "get": {
        "tags": [
          "Profiles"
        ],
        "summary": "Get a public profile",
        "parameters": [
          {
            "name": "user_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/UserId"
          }
        ],
        "responses": {
          "200": {
            "description": "Public profile",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Profile"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_profiles_by_user_id"
      }
    },
    "/public-profiles/by-wallet/{wallet_address}": {
      "get": {
        "tags": [
          "Profiles"
        ],
        "summary": "Resolve a public profile by active wallet address",
        "parameters": [
          {
            "name": "wallet_address",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Public profile resolution",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PublicProfileResolution"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_public_profiles_by_wallet_by_wallet_address"
      }
    },
    "/public-profiles/{handle_label}": {
      "get": {
        "tags": [
          "Profiles"
        ],
        "summary": "Resolve a public profile by Pirate or primary linked handle",
        "parameters": [
          {
            "name": "handle_label",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Public profile resolution",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PublicProfileResolution"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_public_profiles_by_handle_label"
      }
    },
    "/communities": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Create a community",
        "description": "Creates a community once all create-time prerequisites are already satisfied.\n\nWhen `namespace` is provided, the server must consume the accepted namespace-verification resource referenced by `namespace.namespace_verification_id`, not just the raw identifier string. Before writing any community state, the server must re-check:\n\n- the accepted namespace verification exists\n- it belongs to the requesting creator\n- it is still accepted and not stale, disputed, or expired\n- its current capabilities still satisfy `club_attach_allowed`\n\nWhen `namespace` is omitted, the community is created without a namespace. A namespace can be attached later via the namespace-attachment endpoint.\n\nPublic v0 create must fail closed when namespace is provided but those checks do not pass.\n",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateCommunityRequest"
              }
            }
          }
        },
        "responses": {
          "202": {
            "description": "Community creation accepted",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityCreateAcceptedResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_communities"
      }
    },
    "/communities/admin/health": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Check community admin service health",
        "responses": {
          "200": {
            "description": "Community admin service health",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          }
        },
        "operationId": "get_communities_admin_health"
      }
    },
    "/communities/{community_id}": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Get a community",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Community",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Community"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id"
      }
    },
    "/communities/{community_id}/money-policy": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Get the active money policy for a community",
        "description": "Returns the resolved effective community funding policy. When the community has not explicitly configured a money policy yet, the server must return the platform-default policy with `policy_origin = default`.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Community money policy",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityMoneyPolicy"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_money_policy"
      },
      "patch": {
        "tags": [
          "Communities"
        ],
        "summary": "Configure or update the money policy for a community",
        "description": "Stores an explicit community funding policy. Changes apply prospectively to future quote generation and routed funding eligibility only; existing purchases remain pinned to their already-issued quote and settlement snapshots.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdateCommunityMoneyPolicyRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Community money policy updated",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityMoneyPolicy"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "patch_communities_by_community_id_money_policy"
      }
    },
    "/communities/{community_id}/pricing-policy": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Get the active pricing policy for a community",
        "description": "Returns the resolved effective community pricing policy. When the community has not explicitly configured a pricing policy yet, the server must return the default non-tiered policy with `policy_origin = default`. This policy controls buyer-visible quote adjustments and is separate from the community money policy used for routing and settlement constraints.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Community pricing policy",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityPricingPolicy"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_pricing_policy"
      },
      "patch": {
        "tags": [
          "Communities"
        ],
        "summary": "Configure or update the pricing policy for a community",
        "description": "Stores an explicit community pricing policy. Changes apply prospectively to future quote generation only; existing purchases remain pinned to the pricing tier and pricing-policy version captured in their quote and settlement snapshots. This policy does not control funding-lane eligibility or settlement routing.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdateCommunityPricingPolicyRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Community pricing policy updated",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityPricingPolicy"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "patch_communities_by_community_id_pricing_policy"
      }
    },
    "/communities/{community_id}/listings": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "List community listings",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Community listings",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityListingListResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_listings"
      },
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Create a community listing",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateCommunityListingRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Community listing created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityListing"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_communities_by_community_id_listings"
      }
    },
    "/communities/{community_id}/listings/{listing_id}": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Get a community listing",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "name": "listing_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Community listing",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityListing"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_listings_by_listing_id"
      },
      "patch": {
        "tags": [
          "Communities"
        ],
        "summary": "Update a community listing",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "name": "listing_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdateCommunityListingRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Community listing updated",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityListing"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "patch_communities_by_community_id_listings_by_listing_id"
      }
    },
    "/communities/{community_id}/purchases": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "List the authenticated buyer's purchases in a community",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Community purchases",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityPurchaseListResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_purchases"
      }
    },
    "/communities/{community_id}/purchases/{purchase_id}": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Get an authenticated buyer's purchase in a community",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "name": "purchase_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Community purchase",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityPurchase"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_purchases_by_purchase_id"
      }
    },
    "/communities/{community_id}/purchase-quote-preflight": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Preflight a community purchase funding lane",
        "description": "Validates a proposed buyer funding lane against the community's active money policy and returns the effective settlement lane snapshot Pirate would require for a future purchase quote. This does not price a listing, reserve a route, or execute settlement.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CommunityPurchaseQuotePreflightRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Community purchase quote preflight",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityPurchaseQuotePreflight"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_communities_by_community_id_purchase_quote_preflight"
      }
    },
    "/communities/{community_id}/purchase-quotes": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Issue a short-lived community purchase quote",
        "description": "Prices a purchase quote from a persisted listing and validates the requested buyer funding lane against the community's active money policy. When nationality-backed regional pricing is enabled, quote resolution must also consult the community's active pricing policy and snapshot the resulting `pricing_policy_version` and `pricing_tier`.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CommunityPurchaseQuoteRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Community purchase quote",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityPurchaseQuote"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_communities_by_community_id_purchase_quotes"
      }
    },
    "/communities/{community_id}/purchase-settlements": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Confirm settlement for an issued community purchase quote",
        "description": "Consumes an existing active purchase quote, verifies it belongs to the authenticated buyer and has not expired, then writes the canonical purchase row and entitlement snapshot before marking the quote consumed.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CommunityPurchaseSettlementRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Community purchase settled",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityPurchaseSettlement"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_communities_by_community_id_purchase_settlements"
      }
    },
    "/communities/{community_id}/purchase-settlements/fail": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Mark a community purchase quote as failed",
        "description": "Marks an active purchase quote as failed when settlement did not finalize successfully. If the quote has already expired, the server should mark it expired instead of failed.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CommunityPurchaseSettlementFailureRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Community purchase quote failure recorded",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityPurchaseSettlementFailure"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_communities_by_community_id_purchase_settlements_fail"
      }
    },
    "/communities/{community_id}/join": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Join a community",
        "description": "The server must always evaluate the platform baseline join gate before considering the community's membership mode.\n\nPublic v0 baseline join eligibility requires at least one approved platform trust credential:\n\n- `unique_human` verified through an accepted provider such as `self` or `very`\n- `wallet_score` verified through `passport` with a passing score\n- operator-approved token-gated exceptions may exist later, but are not configurable through public v0 community creation or public community settings\n\n`open` means no extra community-specific gate beyond that platform baseline. `gated` communities must satisfy the platform baseline and then all active membership-scope community gate rules.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Membership created or request recorded",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/MembershipResult"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/GateFailed"
          }
        },
        "operationId": "post_communities_by_community_id_join"
      }
    },
    "/communities/{community_id}/membership-requests": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "List pending membership requests",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/Cursor"
          },
          {
            "$ref": "#/components/parameters/Limit"
          }
        ],
        "responses": {
          "200": {
            "description": "Membership requests",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/MembershipRequestListResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_membership_requests"
      }
    },
    "/communities/{community_id}/membership-requests/{membership_request_id}/approve": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Approve a membership request",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "in": "path",
            "name": "membership_request_id",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Membership request approved",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/MembershipRequestSummary"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_communities_by_community_id_membership_requests_by_membership_request_id_approve"
      }
    },
    "/communities/{community_id}/membership-requests/{membership_request_id}/reject": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Reject a membership request",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "in": "path",
            "name": "membership_request_id",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Membership request rejected",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/MembershipRequestSummary"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_communities_by_community_id_membership_requests_by_membership_request_id_reject"
      }
    },
    "/communities/{community_id}/follow": {
      "put": {
        "tags": [
          "Communities"
        ],
        "summary": "Follow a community",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Community follow state updated",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityFollowResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "put_communities_by_community_id_follow"
      },
      "delete": {
        "tags": [
          "Communities"
        ],
        "summary": "Unfollow a community",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Community follow state updated",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityFollowResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "delete_communities_by_community_id_follow"
      }
    },
    "/communities/{community_id}/preview": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Preview a community as a viewer",
        "description": "Returns a viewer-safe community preview for active communities. Unlike the owner-only\nGET /communities/{community_id}, this endpoint does not require ownership and omits\nowner-only internal fields. Includes membership gate summaries so the viewer can\nunderstand join requirements before attempting to join.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Community preview",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommunityPreview"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_preview"
      }
    },
    "/communities/{community_id}/join-eligibility": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Check join eligibility for a community",
        "description": "Returns a machine-readable join eligibility assessment for the authenticated user.\nThe client should use this to determine whether to show a Join button, a Verify to Join\nCTA, or a blocking message before the user attempts to join.\n\nThe `status` field distinguishes:\n- `joinable`: user can join immediately\n- `verification_required`: user is missing a remediable proof (e.g. nationality from self)\n- `gate_failed`: user's existing proof does not satisfy the gate (e.g. nationality mismatch)\n- `already_joined`: user is already a member\n- `banned`: user is banned from the community\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Join eligibility",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/JoinEligibility"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_join_eligibility"
      }
    },
    "/communities/{community_id}/posts": {
      "post": {
        "tags": [
          "Posts"
        ],
        "summary": "Create a post in a community",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "description": "Post creation is scoped to a community. The caller names the target community in the route,\nand the request body must not repeat `community_id`.\n\nPublic v0 posting requires community membership plus `verification_capabilities.unique_human.state = verified`\nfrom an accepted human-verification provider. There is no public v0 exception path for unverified posting or anonymous posting.\n\nWhen `authorship_mode = user_agent`, the caller must additionally provide `agent_id` plus a\nvalid `agent_action_proof`, and the server must verify:\n\n- the agent ownership record is currently valid\n- the owning human remains in good standing\n- the community's effective agent-posting policy allows the attempted write\n\nThe server should run required analysis before making the post publicly visible:\n\n- platform-required safety analysis\n- rights/reference analysis where applicable\n- community authenticity/source policy evaluation where applicable\n\nRecommended outcome mapping:\n\n- `201` when the post is created and publishable in the current state\n- `202` when the post is created or retained in a non-published review-held state because analysis resolved to `review_required`\n- `422` when analysis resolved to `blocked`\n\nRequired analysis timeout or provider failure should normally resolve to a non-published hold/review outcome rather than publish-first behavior.\n\nSong post bundle gating: when `post_type = song` and `song_artifact_bundle_id` is provided, the server must reject the request if the referenced bundle is not in `ready` state. Consumed bundles must not be reused for a second song post.\n\nMarket-context enrichment is explicitly async and read-side only. It does not run at post-create time and does not gate publication. Market-context attachment happens after a post is published, for eligible link posts only, based on the community's resolved market-context policy.\n",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreatePostRequest"
              },
              "examples": {
                "text_basic": {
                  "summary": "Minimal text post with body only",
                  "value": {
                    "idempotency_key": "post_create_text_001",
                    "post_type": "text",
                    "body": "Looking for feedback on tonight's set."
                  }
                },
                "image_basic": {
                  "summary": "Image post with one uploaded image ref",
                  "value": {
                    "idempotency_key": "post_create_image_001",
                    "post_type": "image",
                    "caption": "Poster draft for next week.",
                    "media_refs": [
                      {
                        "storage_ref": "ipfs://bafybeiposterimage001",
                        "mime_type": "image/png",
                        "size_bytes": 482193,
                        "content_hash": "0ximgposter001"
                      }
                    ]
                  }
                },
                "video_basic": {
                  "summary": "Video post with one uploaded video ref",
                  "value": {
                    "idempotency_key": "post_create_video_001",
                    "post_type": "video",
                    "title": "Rehearsal clip",
                    "media_refs": [
                      {
                        "storage_ref": "ipfs://bafybeivideoclip001",
                        "mime_type": "video/mp4",
                        "size_bytes": 18421933,
                        "content_hash": "0xvideoclip001",
                        "duration_ms": 27400
                      }
                    ]
                  }
                },
                "link_basic": {
                  "summary": "Link post with optional title and commentary",
                  "value": {
                    "idempotency_key": "post_create_link_001",
                    "post_type": "link",
                    "title": "Fed meeting recap",
                    "body": "This is the cleanest summary I have seen so far.",
                    "link_url": "https://news.example.com/fed-meeting-recap"
                  }
                },
                "song_bundle_original": {
                  "summary": "Song post backed by a registered artifact bundle",
                  "value": {
                    "idempotency_key": "post_create_song_bundle_001",
                    "post_type": "song",
                    "identity_mode": "public",
                    "title": "Harbor Lights",
                    "song_mode": "original",
                    "rights_basis": "original",
                    "song_artifact_bundle_id": "sab_01HSONGBUNDLE001"
                  }
                },
                "song_inline_remix": {
                  "summary": "Inline remix song post with audio, lyrics, and upstream attribution",
                  "value": {
                    "idempotency_key": "post_create_song_inline_001",
                    "post_type": "song",
                    "identity_mode": "public",
                    "title": "Harbor Lights (Night Edit)",
                    "song_mode": "remix",
                    "rights_basis": "derivative",
                    "upstream_asset_refs": [
                      "ast_01HUPSTREAM001"
                    ],
                    "media_refs": [
                      {
                        "storage_ref": "ipfs://bafybeiaudioedit001",
                        "mime_type": "audio/mpeg",
                        "size_bytes": 9234411,
                        "content_hash": "0xaudioedit001",
                        "duration_ms": 201000
                      }
                    ],
                    "lyrics": "Streetlights on the water, echoes in the bay.\nCut the drums lower, let the old hook stay.\n"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Post created. Returns the canonical post row; localized read projections are returned by `GET /posts/{post_id}`.\n",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Post"
                }
              }
            }
          },
          "202": {
            "description": "Post accepted into a non-published review state. The canonical post row exists, but publication is held pending moderation or compliance review.\n",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Post"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          },
          "422": {
            "$ref": "#/components/responses/AnalysisBlocked"
          },
          "429": {
            "$ref": "#/components/responses/PostingQuotaExhausted"
          }
        },
        "operationId": "post_communities_by_community_id_posts"
      },
      "get": {
        "tags": [
          "Posts"
        ],
        "summary": "List posts in a community",
        "description": "Returns community feed items for published posts only. Non-published posts such as review-held drafts are not visible in this list.\n\nThe current v0 implemented surface returns newest-first results and may ignore ranking parameters such as `sort` and `top_window`.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/Locale"
          },
          {
            "$ref": "#/components/parameters/FeedSort"
          },
          {
            "$ref": "#/components/parameters/TopWindow"
          },
          {
            "$ref": "#/components/parameters/LabelId"
          },
          {
            "$ref": "#/components/parameters/Cursor"
          },
          {
            "$ref": "#/components/parameters/Limit"
          }
        ],
        "responses": {
          "200": {
            "description": "Community posts",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/FeedResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "get_communities_by_community_id_posts"
      }
    },
    "/communities/{community_id}/posts/{post_id}/comments": {
      "get": {
        "tags": [
          "Comments"
        ],
        "summary": "List top-level comments for a post thread",
        "parameters": [
          {
            "name": "post_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/PostId"
          },
          {
            "$ref": "#/components/parameters/FeedSort"
          },
          {
            "$ref": "#/components/parameters/Cursor"
          },
          {
            "$ref": "#/components/parameters/Limit"
          }
        ],
        "responses": {
          "200": {
            "description": "Top-level comments",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommentListResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_posts_by_post_id_comments"
      },
      "post": {
        "tags": [
          "Comments"
        ],
        "summary": "Create a top-level comment under a post thread",
        "parameters": [
          {
            "name": "post_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/PostId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateCommentRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Comment created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Comment"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_communities_by_community_id_posts_by_post_id_comments"
      }
    },
    "/communities/{community_id}/posts/{post_id}/reports": {
      "post": {
        "tags": [
          "Moderation"
        ],
        "summary": "Report a post in a community",
        "description": "Creates a user report for the target post. If an open moderation case already exists for the\npost, the report should attach to that case rather than creating a duplicate. Otherwise the\nserver may open a new community-scoped moderation case.\n",
        "parameters": [
          {
            "name": "post_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/PostId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateUserReportRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "User report created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UserReport"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_communities_by_community_id_posts_by_post_id_reports"
      }
    },
    "/communities/{community_id}/comments/{comment_id}/reports": {
      "post": {
        "tags": [
          "Moderation"
        ],
        "summary": "Report a comment in a community",
        "description": "Creates a user report for the target comment. If an open moderation case already exists for the\ncomment, the report should attach to that case rather than creating a duplicate. Otherwise the\nserver may open a new community-scoped moderation case.\n",
        "parameters": [
          {
            "name": "comment_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/CommentId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateUserReportRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "User report created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UserReport"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_communities_by_community_id_comments_by_comment_id_reports"
      }
    },
    "/communities/{community_id}/moderation/cases": {
      "get": {
        "tags": [
          "Moderation"
        ],
        "summary": "List moderation cases for a community",
        "description": "Returns moderation cases for the community. V0 is expected to focus on open cases used by\nsingle creators or moderators through a simple `Needs Review` surface.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Moderation cases",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ModerationCaseListResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_moderation_cases"
      }
    },
    "/communities/{community_id}/moderation/cases/{moderation_case_id}": {
      "get": {
        "tags": [
          "Moderation"
        ],
        "summary": "Read a moderation case",
        "description": "Returns the case, target post, attached moderation signals, attached user reports, and any\nprior moderation actions for a single moderation case.\n",
        "parameters": [
          {
            "name": "moderation_case_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/ModerationCaseId"
          }
        ],
        "responses": {
          "200": {
            "description": "Moderation case detail",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ModerationCaseDetail"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_moderation_cases_by_moderation_case_id"
      }
    },
    "/communities/{community_id}/moderation/cases/{moderation_case_id}/actions": {
      "post": {
        "tags": [
          "Moderation"
        ],
        "summary": "Resolve a moderation case with an action",
        "description": "Appends a moderation action to the case and updates the target post when the selected action\nimplies a post-state change such as `hide`, `remove`, `restore`, or `age_gate`.\n",
        "parameters": [
          {
            "name": "moderation_case_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/ModerationCaseId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateModerationActionRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Moderation case detail after action",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ModerationCaseDetail"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_communities_by_community_id_moderation_cases_by_moderation_case_id_actions"
      }
    },
    "/communities/{community_id}/song-artifact-uploads": {
      "post": {
        "tags": [
          "Posts"
        ],
        "summary": "Create a song artifact upload intent",
        "description": "Creates a local upload intent for a song artifact. The returned `upload_url` is the route the client should use to upload bytes in the first implemented slice.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateSongArtifactUploadRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Song artifact upload intent",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongArtifactUpload"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/PostingQuotaExhausted"
          }
        },
        "operationId": "post_communities_by_community_id_song_artifact_uploads"
      }
    },
    "/communities/{community_id}/song-artifact-uploads/{song_artifact_upload_id}/content": {
      "put": {
        "tags": [
          "Posts"
        ],
        "summary": "Upload song artifact content",
        "description": "Uploads bytes for a previously created song artifact upload intent. The first implemented slice accepts either raw bytes or JSON `content_base64`.\n",
        "parameters": [
          {
            "name": "song_artifact_upload_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/SongArtifactUploadId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/octet-stream": {
              "schema": {
                "type": "string",
                "format": "binary"
              }
            },
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/SongArtifactUploadContentRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Song artifact upload completed",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongArtifactUpload"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "put_communities_by_community_id_song_artifact_uploads_by_song_artifact_upload_id_content"
      }
    },
    "/communities/{community_id}/song-artifacts": {
      "post": {
        "tags": [
          "Posts"
        ],
        "summary": "Register a mainline song artifact bundle for a community",
        "description": "Registers song artifact upload references into a bundle for later post creation. This endpoint does not upload binaries and does not publish a post.\n\nAll artifact inputs must reference previously created upload intents whose `status` is `uploaded`. The server resolves each `song_artifact_upload_id` into the corresponding storage ref and metadata. Callers must not submit freeform `storage_ref` descriptors directly.\n\nAfter registration, the bundle transitions through validation (`draft` -> `validating` -> `ready` or `failed`). Only a bundle in `ready` state may be used for song post creation. The server validates mime types, required fields, and package completeness during the `validating` transition.\n\nPublic v0 mainline rules for this first slice:\n\n- caller must be an authenticated community member\n- caller must satisfy `verification_capabilities.unique_human.state = verified`\n- `primary_audio` upload reference and non-empty `lyrics` are required\n- optional `cover_art`, `preview_audio`, `canvas_video`, `instrumental_audio`, and `vocal_audio` are accepted as upload references only\n- no cover-art or canvas geometry enforcement is performed in this first implemented slice\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateSongArtifactBundleRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Song artifact bundle registered",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongArtifactBundle"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/PostingQuotaExhausted"
          }
        },
        "operationId": "post_communities_by_community_id_song_artifacts"
      }
    },
    "/communities/{community_id}/song-artifacts/{song_artifact_bundle_id}": {
      "get": {
        "tags": [
          "Posts"
        ],
        "summary": "Read a registered song artifact bundle",
        "description": "Returns a previously registered mainline song artifact bundle. In the current implemented slice, direct reads are limited to the bundle creator.\n",
        "parameters": [
          {
            "name": "song_artifact_bundle_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/SongArtifactBundleId"
          }
        ],
        "responses": {
          "200": {
            "401": {
              "$ref": "#/components/responses/AuthError"
            },
            "404": {
              "$ref": "#/components/responses/NotFound"
            },
            "description": "Song artifact bundle",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongArtifactBundle"
                }
              }
            }
          }
        },
        "operationId": "get_communities_by_community_id_song_artifacts_by_song_artifact_bundle_id"
      },
      "communities_by_community_id_provenance_policy": {
        "get": {
          "tags": [
            "Communities"
          ],
          "summary": "Get the active provenance policy for a community",
          "description": "Returns the resolved effective provenance policy. When the community has not explicitly configured a provenance policy yet, the server must return the restrictive default policy with `policy_origin = default`.\n",
          "parameters": [
            {
              "$ref": "#/components/parameters/CommunityId"
            }
          ],
          "responses": {
            "200": {
              "description": "Community provenance policy",
              "content": {
                "application/json": {
                  "schema": {
                    "$ref": "#/components/schemas/CommunityProvenancePolicy"
                  }
                }
              }
            },
            "401": {
              "$ref": "#/components/responses/AuthError"
            },
            "404": {
              "$ref": "#/components/responses/NotFound"
            }
          }
        },
        "patch": {
          "tags": [
            "Communities"
          ],
          "summary": "Configure or update the provenance policy for a community",
          "description": "Stores an explicit community provenance policy for creator-relation claims and false-claim-of-ownership enforcement. Changes apply prospectively to future posts and moderation decisions, but does not retroactively reclassify existing posts.\n",
          "parameters": [
            {
              "$ref": "#/components/parameters/CommunityId"
            }
          ],
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UpdateCommunityProvenancePolicyRequest"
                }
              }
            }
          },
          "responses": {
            "200": {
              "description": "Community provenance policy updated",
              "content": {
                "application/json": {
                  "schema": {
                    "$ref": "#/components/schemas/CommunityProvenancePolicy"
                  }
                }
              }
            },
            "401": {
              "$ref": "#/components/responses/AuthError"
            },
            "403": {
              "$ref": "#/components/responses/EligibilityFailed"
            },
            "404": {
              "$ref": "#/components/responses/NotFound"
            },
            "409": {
              "$ref": "#/components/responses/Conflict"
            },
            "429": {
              "$ref": "#/components/responses/RateLimited"
            }
          }
        }
      },
      "communities_by_community_id_promotion_policy": {
        "get": {
          "tags": [
            "Communities"
          ],
          "summary": "Get the active promotion policy for a community",
          "description": "Returns the resolved effective promotion policy. When the community has not explicitly configured a promotion policy yet, the server must return the default policy with `policy_origin = default`.\n",
          "parameters": [
            {
              "$ref": "#/components/parameters/CommunityId"
            }
          ],
          "responses": {
            "200": {
              "description": "Community promotion policy",
              "content": {
                "application/json": {
                  "schema": {
                    "$ref": "#/components/schemas/CommunityPromotionPolicy"
                  }
                }
              }
            },
            "401": {
              "$ref": "#/components/responses/AuthError"
            },
            "404": {
              "$ref": "#/components/responses/NotFound"
            }
          }
        },
        "patch": {
          "tags": [
            "Communities"
          ],
          "summary": "Configure or update the promotion policy for a community",
          "description": "Stores an explicit community promotion policy for self-promotion, affiliation disclosure, and participation-ratio enforcement. Changes apply prospectively to future posts and moderation decisions, but does not retroactively reclassify existing posts.\n",
          "parameters": [
            {
              "$ref": "#/components/parameters/CommunityId"
            }
          ],
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UpdateCommunityPromotionPolicyRequest"
                }
              }
            }
          },
          "responses": {
            "200": {
              "description": "Community promotion policy updated",
              "content": {
                "application/json": {
                  "schema": {
                    "$ref": "#/components/schemas/CommunityPromotionPolicy"
                  }
                }
              }
            },
            "401": {
              "$ref": "#/components/responses/AuthError"
            },
            "403": {
              "$ref": "#/components/responses/EligibilityFailed"
            },
            "404": {
              "$ref": "#/components/responses/NotFound"
            },
            "409": {
              "$ref": "#/components/responses/Conflict"
            },
            "429": {
              "$ref": "#/components/responses/RateLimited"
            }
          }
        }
      }
    },
    "/posts/{post_id}": {
      "get": {
        "tags": [
          "Posts"
        ],
        "summary": "Get a post",
        "description": "Returns a localized canonical post read.\n\nPublished posts are readable to callers with community access. Non-published posts such as review-held drafts are only readable to the post author or the community owner in the current v0 implemented surface.\n",
        "parameters": [
          {
            "name": "post_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/PostId"
          },
          {
            "$ref": "#/components/parameters/Locale"
          }
        ],
        "responses": {
          "200": {
            "description": "Post",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/LocalizedPostResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_posts_by_post_id"
      }
    },
    "/posts/{post_id}/vote": {
      "post": {
        "tags": [
          "Posts"
        ],
        "summary": "Cast or update a vote on a post",
        "description": "Public v0 voting requires community membership plus `verification_capabilities.unique_human.state = verified`\nfrom an accepted human-verification provider such as `self` or `very`.\nUser-owned agents must not cast votes through this surface in v0.\n",
        "parameters": [
          {
            "name": "post_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/PostId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "value"
                ],
                "properties": {
                  "value": {
                    "type": "integer",
                    "enum": [
                      -1,
                      1
                    ]
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Vote recorded",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PostVoteResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "post_posts_by_post_id_vote"
      }
    },
    "/comments/{comment_id}": {
      "delete": {
        "tags": [
          "Comments"
        ],
        "summary": "Tombstone a comment",
        "parameters": [
          {
            "name": "comment_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommentId"
          }
        ],
        "responses": {
          "200": {
            "description": "Comment tombstoned",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Comment"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "delete_comments_by_comment_id"
      }
    },
    "/comments/{comment_id}/replies": {
      "get": {
        "tags": [
          "Comments"
        ],
        "summary": "List direct replies for a comment",
        "parameters": [
          {
            "name": "comment_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommentId"
          },
          {
            "$ref": "#/components/parameters/FeedSort"
          },
          {
            "$ref": "#/components/parameters/Cursor"
          },
          {
            "$ref": "#/components/parameters/Limit"
          }
        ],
        "responses": {
          "200": {
            "description": "Direct replies",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommentListResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_comments_by_comment_id_replies"
      },
      "post": {
        "tags": [
          "Comments"
        ],
        "summary": "Create a reply beneath a comment",
        "parameters": [
          {
            "name": "comment_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommentId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateCommentRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Comment created",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Comment"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_comments_by_comment_id_replies"
      }
    },
    "/comments/{comment_id}/context": {
      "get": {
        "tags": [
          "Comments"
        ],
        "summary": "Load permalink context for a comment",
        "parameters": [
          {
            "name": "comment_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommentId"
          },
          {
            "$ref": "#/components/parameters/Cursor"
          },
          {
            "$ref": "#/components/parameters/Limit"
          }
        ],
        "responses": {
          "200": {
            "description": "Comment context",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommentContext"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_comments_by_comment_id_context"
      }
    },
    "/comments/{comment_id}/vote": {
      "post": {
        "tags": [
          "Comments"
        ],
        "summary": "Cast or update a vote on a comment",
        "parameters": [
          {
            "name": "comment_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommentId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "value"
                ],
                "properties": {
                  "value": {
                    "type": "integer",
                    "enum": [
                      -1,
                      1
                    ]
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Vote recorded",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommentVoteResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "403": {
            "$ref": "#/components/responses/VerificationRequired"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_comments_by_comment_id_vote"
      }
    },
    "/notifications/summary": {
      "get": {
        "operationId": "notifications_summary",
        "tags": [
          "Notifications"
        ],
        "summary": "Get notification summary for badge state",
        "responses": {
          "200": {
            "description": "Notification summary",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/NotificationSummary"
                }
              }
            }
          }
        }
      }
    },
    "/notifications/tasks": {
      "get": {
        "operationId": "notifications_tasks",
        "tags": [
          "Notifications"
        ],
        "summary": "List open tasks for the current user",
        "responses": {
          "200": {
            "description": "User tasks",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/NotificationTasksResponse"
                }
              }
            }
          }
        }
      }
    },
    "/notifications/feed": {
      "get": {
        "operationId": "notifications_feed",
        "tags": [
          "Notifications"
        ],
        "summary": "List activity feed items for the current user",
        "parameters": [
          {
            "name": "cursor",
            "in": "query",
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "limit",
            "in": "query",
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100,
              "default": 25
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Activity feed",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/NotificationFeedResponse"
                }
              }
            }
          }
        }
      }
    },
    "/notifications/mark-read": {
      "post": {
        "operationId": "notifications_mark_read",
        "tags": [
          "Notifications"
        ],
        "summary": "Mark activity items as read",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/MarkNotificationsReadRequest"
              }
            }
          }
        },
        "responses": {
          "204": {
            "description": "Marked as read"
          }
        }
      }
    },
    "/notifications/dismiss-task": {
      "post": {
        "operationId": "notifications_dismiss_task",
        "tags": [
          "Notifications"
        ],
        "summary": "Dismiss a user task",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/DismissTaskRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Task dismissed",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UserTask"
                }
              }
            }
          }
        }
      }
    },
    "/jobs/{job_id}": {
      "get": {
        "tags": [
          "Jobs"
        ],
        "summary": "Inspect a pollable async job",
        "parameters": [
          {
            "name": "job_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/JobId"
          }
        ],
        "responses": {
          "200": {
            "description": "Job",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Job"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_jobs_by_job_id"
      }
    },
    "/public-communities": {
      "get": {
        "tags": [
          "Communities"
        ],
        "x-implemented": true,
        "security": [],
        "summary": "Search public communities",
        "parameters": [
          {
            "name": "query",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string",
              "minLength": 2
            }
          },
          {
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 25,
              "default": 10
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Public community search results",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "query",
                    "communities"
                  ],
                  "properties": {
                    "query": {
                      "type": "string",
                      "nullable": true
                    },
                    "communities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "required": [
                          "community_id",
                          "display_name"
                        ],
                        "properties": {
                          "community_id": {
                            "type": "string"
                          },
                          "display_name": {
                            "type": "string"
                          },
                          "route_slug": {
                            "type": "string",
                            "nullable": true
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "get_public_communities"
      }
    },
    "/public-communities/{community_id}": {
      "get": {
        "tags": [
          "Communities"
        ],
        "x-implemented": true,
        "security": [],
        "summary": "Get structured public community",
        "description": "Returns public community identity, included structured surfaces, omitted-surface metadata, and traversal links. If a child surface is opted out, the parent response remains `200` and lists the omitted surface.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
            "description": "Structured public community",
            "headers": {
              "Link": {
                "schema": {
                  "type": "string"
                },
                "description": "HTTP traversal and discovery links where practical."
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/StructuredPublicCommunityResponse"
                }
              },
              "text/markdown": {
                "schema": {
                  "type": "string"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "get_public_communities_by_community_id"
      }
    },
    "/public-communities/{community_id}/posts": {
      "get": {
        "tags": [
          "Communities"
        ],
        "x-implemented": true,
        "security": [],
        "summary": "List structured public community posts",
        "description": "Returns structured thread cards and, when allowed, thread bodies. If `thread_bodies` is opted out, cards remain available and `omitted_surfaces` explains the omission. If `thread_cards` is disabled, direct requests return `structured_surface_disabled`.\n",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/Cursor"
          },
          {
            "$ref": "#/components/parameters/Limit"
          }
        ],
        "responses": {
          "200": {
            "description": "Structured public post list",
            "headers": {
              "Link": {
                "schema": {
                  "type": "string"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/StructuredPublicPostListResponse"
                }
              }
            }
          },
          "403": {
            "$ref": "#/components/responses/StructuredSurfaceDisabled"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "get_public_communities_by_community_id_posts"
      }
    },
    "/public-posts/{post_id}": {
      "get": {
        "tags": [
          "Posts"
        ],
        "x-implemented": true,
        "security": [],
        "summary": "Get structured public post",
        "description": "Returns a structured public post card and, when allowed, body/media metadata. Traversal links point to canonical HTML, markdown, community, and top comments when enabled.\n",
        "parameters": [
          {
            "name": "post_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/PostId"
          }
        ],
        "responses": {
          "200": {
            "description": "Structured public post",
            "headers": {
              "Link": {
                "schema": {
                  "type": "string"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/StructuredPublicPostResponse"
                }
              },
              "text/markdown": {
                "schema": {
                  "type": "string"
                }
              }
            }
          },
          "403": {
            "$ref": "#/components/responses/StructuredSurfaceDisabled"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "get_public_posts_by_post_id"
      }
    },
    "/public-posts/{post_id}/top-comments": {
      "get": {
        "tags": [
          "Comments"
        ],
        "x-implemented": true,
        "security": [],
        "summary": "Get structured public top comments",
        "description": "Returns only the top N comments for a public thread. Full comment-tree access is not a v0 API guarantee. If top comments are disabled, direct requests return `structured_surface_disabled`.\n",
        "parameters": [
          {
            "name": "post_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/PostId"
          }
        ],
        "responses": {
          "200": {
            "description": "Structured top comments",
            "headers": {
              "Link": {
                "schema": {
                  "type": "string"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/StructuredTopCommentsResponse"
                }
              }
            }
          },
          "403": {
            "$ref": "#/components/responses/StructuredSurfaceDisabled"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "get_public_posts_by_post_id_top_comments"
      }
    },
    "/public-comments/posts/{post_id}/comments": {
      "get": {
        "tags": [
          "Comments"
        ],
        "x-implemented": true,
        "security": [],
        "summary": "List public comments for a post",
        "parameters": [
          {
            "name": "post_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/Cursor"
          },
          {
            "$ref": "#/components/parameters/Limit"
          }
        ],
        "responses": {
          "200": {
            "description": "Public comments",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommentListResponse"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "get_public_comments_posts_by_post_id_comments"
      }
    },
    "/public-comments/{comment_id}/replies": {
      "get": {
        "tags": [
          "Comments"
        ],
        "x-implemented": true,
        "security": [],
        "summary": "List public replies for a comment",
        "parameters": [
          {
            "name": "comment_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "$ref": "#/components/parameters/Cursor"
          },
          {
            "$ref": "#/components/parameters/Limit"
          }
        ],
        "responses": {
          "200": {
            "description": "Public comment replies",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/CommentListResponse"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "get_public_comments_by_comment_id_replies"
      }
    }
  },
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "JWT"
      },
      "paymentAuth": {
        "type": "apiKey",
        "in": "header",
        "name": "Authorization",
        "description": "Payment credential sent as `Authorization: Payment ...` on retry after an MPP `402 Payment Required` challenge.\n"
      }
    },
    "parameters": {
      "CommunityId": {
        "in": "path",
        "name": "community_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "NamespaceId": {
        "in": "path",
        "name": "namespace_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "UserId": {
        "in": "path",
        "name": "user_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "PostId": {
        "in": "path",
        "name": "post_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "SongArtifactBundleId": {
        "in": "path",
        "name": "song_artifact_bundle_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "SongArtifactUploadId": {
        "in": "path",
        "name": "song_artifact_upload_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "LiveRoomId": {
        "in": "path",
        "name": "live_room_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "TrackId": {
        "in": "path",
        "name": "track_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "JobId": {
        "in": "path",
        "name": "job_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "ModerationCaseId": {
        "in": "path",
        "name": "moderation_case_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "VerificationSessionId": {
        "in": "path",
        "name": "verification_session_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "AgentOwnershipSessionId": {
        "in": "path",
        "name": "agent_ownership_session_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "AgentId": {
        "in": "path",
        "name": "agent_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "NamespaceVerificationSessionId": {
        "in": "path",
        "name": "namespace_verification_session_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "NamespaceVerificationId": {
        "in": "path",
        "name": "namespace_verification_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "CommunityReferenceLinkId": {
        "in": "path",
        "name": "community_reference_link_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "CommunityReferenceLinkProofId": {
        "in": "path",
        "name": "proof_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "FeedSort": {
        "in": "query",
        "name": "sort",
        "schema": {
          "type": "string",
          "enum": [
            "best",
            "top",
            "new"
          ]
        }
      },
      "Locale": {
        "in": "query",
        "name": "locale",
        "description": "Optional locale override for localized read surfaces. When omitted, the server should resolve locale using the SSR precedence contract.\n",
        "schema": {
          "type": "string"
        }
      },
      "Cursor": {
        "in": "query",
        "name": "cursor",
        "schema": {
          "type": "string"
        }
      },
      "Limit": {
        "in": "query",
        "name": "limit",
        "schema": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100
        }
      },
      "TopWindow": {
        "in": "query",
        "name": "top_window",
        "schema": {
          "type": "string",
          "enum": [
            "now",
            "today",
            "this_week",
            "this_month",
            "all_time"
          ]
        }
      },
      "LabelId": {
        "in": "query",
        "name": "label_id",
        "schema": {
          "type": "string",
          "nullable": true
        }
      },
      "CommentId": {
        "in": "path",
        "name": "comment_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "AssetId": {
        "in": "path",
        "name": "asset_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "HandleLabel": {
        "in": "path",
        "name": "handle_label",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    },
    "responses": {
      "AuthError": {
        "description": "Authentication failed",
        "content": {
          "application/json": {
            "examples": {
              "default": {
                "summary": "Standard auth failure",
                "value": {
                  "code": "auth_error",
                  "message": "Authentication failed",
                  "retryable": false
                }
              }
            },
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "PaymentRequired": {
        "description": "Payment is required before the resource can be accessed",
        "headers": {
          "WWW-Authenticate": {
            "description": "MPP payment challenge header",
            "schema": {
              "type": "string"
            }
          }
        },
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/mpp.yaml#/MppChallenge"
            }
          }
        }
      },
      "PaymentRequiredOrFailed": {
        "description": "Payment is required or a payment attempt failed",
        "headers": {
          "WWW-Authenticate": {
            "description": "MPP payment challenge header",
            "schema": {
              "type": "string"
            }
          }
        },
        "content": {
          "application/json": {
            "schema": {
              "oneOf": [
                {
                  "$ref": "./schemas/mpp.yaml#/MppChallenge"
                },
                {
                  "$ref": "./schemas/mpp.yaml#/PaymentFailure"
                }
              ]
            }
          }
        }
      },
      "VerificationRequired": {
        "description": "Verification is required",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "MppExportForbidden": {
        "description": "Export blocked by a community gate or export-eligibility rule",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "GateFailed": {
        "description": "Community gate or membership rule failed",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "EligibilityFailed": {
        "description": "Policy or eligibility requirement failed",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "PostingTrustTierTooLow": {
        "description": "The requested posting action is not available at the author's current community trust level",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "PostingQuotaExhausted": {
        "description": "The requested posting action is temporarily unavailable until the relevant posting window resets",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "AnalysisBlocked": {
        "description": "Content analysis blocked publication",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "Conflict": {
        "description": "Resource conflict",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "NotFound": {
        "description": "Resource not found",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "RateLimited": {
        "description": "Request rate limited",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "BadRequest": {
        "description": "Request payload or parameters are invalid",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "Forbidden": {
        "description": "Authenticated caller is not allowed to perform the requested action",
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "StructuredSurfaceDisabled": {
        "description": "The underlying resource is visible, but this structured surface is disabled by community or platform policy",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "code",
                "message"
              ],
              "properties": {
                "code": {
                  "type": "string",
                  "enum": [
                    "structured_surface_disabled"
                  ]
                },
                "message": {
                  "type": "string"
                },
                "retryable": {
                  "type": "boolean",
                  "default": false
                },
                "details": {
                  "type": "object",
                  "nullable": true,
                  "additionalProperties": true
                }
              }
            },
            "examples": {
              "default": {
                "summary": "Structured surface disabled",
                "value": {
                  "code": "structured_surface_disabled",
                  "message": "This structured surface is disabled for this community.",
                  "retryable": false
                }
              }
            }
          }
        }
      }
    },
    "schemas": {
      "Error": {
        "type": "object",
        "required": [
          "code",
          "message"
        ],
        "properties": {
          "code": {
            "type": "string",
            "enum": [
              "bad_request",
              "auth_error",
              "payment_required",
              "verification_required",
              "eligibility_failed",
              "gate_failed",
              "posting_trust_tier_too_low",
              "posting_quota_exhausted",
              "analysis_blocked",
              "analysis_review_required",
              "label_required",
              "invalid_label_selection",
              "label_required_but_none_applicable",
              "conflict",
              "not_found",
              "rate_limited",
              "payment_failed",
              "settlement_pending",
              "provider_unavailable",
              "internal_error"
            ]
          },
          "message": {
            "type": "string"
          },
          "retryable": {
            "type": "boolean",
            "default": false
          },
          "details": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          }
        }
      },
      "SessionExchangeResponse": {
        "type": "object",
        "required": [
          "access_token",
          "user",
          "profile",
          "onboarding",
          "wallet_attachments"
        ],
        "properties": {
          "access_token": {
            "type": "string"
          },
          "user": {
            "$ref": "./users.yaml#/User"
          },
          "profile": {
            "$ref": "./profiles.yaml#/Profile"
          },
          "onboarding": {
            "$ref": "./onboarding.yaml#/OnboardingStatus"
          },
          "wallet_attachments": {
            "type": "array",
            "description": "Wallet attachments available to the authenticated Pirate user at session bootstrap time.\nThis lets clients render the active execution wallet without relying on provider SDK\nside channels or an immediate follow-up fetch. This field is always present. In the first\nexecutable `jwt_based_auth` slice, newly created JWT-path users return `[]` because that\nrequest variant does not create wallet attachments.\n",
            "items": {
              "$ref": "./auth.yaml#/WalletAttachmentSummary"
            }
          }
        }
      },
      "User": {
        "type": "object",
        "description": "Public user read model. Sensitive verified-identity fields that may exist in canonical storage,\nsuch as `date_of_birth`, `age_at_verification`, provider nullifiers, and\n`verification_session_id`, are intentionally omitted from this schema in v0.\n",
        "required": [
          "user_id",
          "verification_state",
          "verification_capabilities",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "user_id": {
            "type": "string"
          },
          "community_posting_state": {
            "type": "object",
            "nullable": true,
            "properties": {
              "community_ref": {
                "type": "string"
              },
              "community_id": {
                "type": "string"
              },
              "has_created_text_post": {
                "type": "boolean"
              }
            }
          },
          "primary_wallet_attachment_id": {
            "type": "string",
            "nullable": true
          },
          "verification_state": {
            "type": "string",
            "enum": [
              "unverified",
              "pending",
              "verified",
              "reverification_required"
            ]
          },
          "capability_provider": {
            "type": "string",
            "enum": [
              "self",
              "very"
            ],
            "nullable": true,
            "description": "Convenience summary for the provider that produced the most recent accepted core capability set. Per-capability `provider` fields inside `verification_capabilities` remain authoritative.\n"
          },
          "verification_capabilities": {
            "$ref": "./verification.yaml#/VerificationCapabilities"
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "VerificationCapabilities": {
        "type": "object",
        "required": [
          "unique_human",
          "age_over_18",
          "minimum_age",
          "nationality",
          "gender",
          "wallet_score"
        ],
        "properties": {
          "unique_human": {
            "$ref": "./verification.yaml#/VerificationCapabilityState"
          },
          "age_over_18": {
            "allOf": [
              {
                "$ref": "./verification.yaml#/VerifiedCapabilityState"
              }
            ],
            "type": "object",
            "properties": {
              "proof_type": {
                "type": "string",
                "enum": [
                  "age_over_18"
                ],
                "nullable": true
              }
            }
          },
          "minimum_age": {
            "allOf": [
              {
                "$ref": "./verification.yaml#/VerifiedCapabilityState"
              }
            ],
            "type": "object",
            "properties": {
              "proof_type": {
                "type": "string",
                "enum": [
                  "minimum_age"
                ],
                "nullable": true
              },
              "value": {
                "type": "integer",
                "nullable": true,
                "description": "Highest reusable minimum-age threshold verified by Self."
              }
            }
          },
          "nationality": {
            "allOf": [
              {
                "$ref": "./verification.yaml#/VerifiedCapabilityState"
              }
            ],
            "type": "object",
            "properties": {
              "proof_type": {
                "type": "string",
                "enum": [
                  "nationality"
                ],
                "nullable": true
              },
              "value": {
                "type": "string",
                "nullable": true,
                "description": "ISO country code when verified"
              }
            }
          },
          "gender": {
            "allOf": [
              {
                "$ref": "./verification.yaml#/VerifiedCapabilityState"
              }
            ],
            "type": "object",
            "properties": {
              "value": {
                "type": "string",
                "enum": [
                  "M",
                  "F"
                ],
                "nullable": true,
                "description": "Verified document marker value when disclosed by an eligible Self flow; currently limited to `M` or `F`"
              },
              "proof_type": {
                "type": "string",
                "enum": [
                  "gender"
                ],
                "nullable": true
              }
            }
          },
          "wallet_score": {
            "$ref": "./verification.yaml#/WalletScoreCapabilityState"
          }
        },
        "description": "Current resolved account-level verification capability state. Public-v0 product policy should\ntreat these capabilities as reusable until they expire, are revoked, or are replaced by a\nfresher accepted proof. For interactive identity capabilities, Pirate should use reactive\nrefresh at gate time rather than background renewal. `gender` remains a high-sensitivity\ndocument-marker disclosure even when enabled as a supported gate capability.\n"
      },
      "RequestedVerificationCapability": {
        "type": "string",
        "enum": [
          "unique_human",
          "age_over_18",
          "minimum_age",
          "nationality",
          "gender"
        ],
        "description": "Canonical capability requested from an interactive verification flow. Public v0 should treat\n`unique_human`, `age_over_18`, `minimum_age`, `nationality`, and a document-derived `gender`\nmarker as the actively supported Self-backed capability set.\n"
      },
      "VerificationIntent": {
        "type": "string",
        "enum": [
          "profile_verification",
          "community_creation",
          "community_join",
          "post_access_18_plus",
          "commerce_pricing",
          "qualifier_disclosure"
        ]
      },
      "VerificationCapabilityState": {
        "type": "object",
        "required": [
          "state"
        ],
        "description": "Capability state for unique_human, which may be pending during an active verification session.\nPublic-v0 product policy should treat `expired` as requiring a fresh verification before the\nnext gated action that depends on this capability.\n",
        "properties": {
          "state": {
            "type": "string",
            "enum": [
              "unverified",
              "pending",
              "verified",
              "expired"
            ]
          },
          "provider": {
            "type": "string",
            "enum": [
              "self",
              "very"
            ],
            "nullable": true
          },
          "proof_type": {
            "type": "string",
            "enum": [
              "unique_human"
            ],
            "nullable": true
          },
          "mechanism": {
            "type": "string",
            "nullable": true
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "VerifiedCapabilityState": {
        "type": "object",
        "required": [
          "state"
        ],
        "description": "Capability state for Self-backed disclosure capabilities in v0. These capabilities have no\npending state — they are either unverified, verified from an accepted record, or expired after\na re-verification requirement. Public-v0 refresh should be reactive at gate time rather than\nbackground or silent.\n",
        "properties": {
          "state": {
            "type": "string",
            "enum": [
              "unverified",
              "verified",
              "expired"
            ]
          },
          "provider": {
            "type": "string",
            "enum": [
              "self"
            ],
            "nullable": true
          },
          "proof_type": {
            "type": "string",
            "enum": [
              "age_over_18",
              "minimum_age",
              "nationality",
              "gender"
            ],
            "nullable": true
          },
          "mechanism": {
            "type": "string",
            "nullable": true
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "SanctionsClearCapabilityState": {
        "type": "object",
        "required": [
          "state"
        ],
        "description": "Capability state for provider-backed sanctions screening in v0. Public v0 currently accepts\nHuman Passport-backed sanctions state only. Self OFAC support remains deferred until Pirate has\npinned the Self launch config, backend verification config, response polarity, and fail-closed\nparser tests.\n",
        "properties": {
          "state": {
            "type": "string",
            "enum": [
              "unverified",
              "verified",
              "expired"
            ]
          },
          "provider": {
            "type": "string",
            "enum": [
              "passport"
            ],
            "nullable": true
          },
          "proof_type": {
            "type": "string",
            "enum": [
              "sanctions_clear"
            ],
            "nullable": true
          },
          "mechanism": {
            "type": "string",
            "enum": [
              "passport_clean_hands",
              "CleanHands"
            ],
            "nullable": true
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "WalletScoreCapabilityState": {
        "type": "object",
        "required": [
          "state"
        ],
        "properties": {
          "state": {
            "type": "string",
            "enum": [
              "unverified",
              "verified",
              "expired"
            ]
          },
          "provider": {
            "type": "string",
            "enum": [
              "passport"
            ],
            "nullable": true
          },
          "proof_type": {
            "type": "string",
            "enum": [
              "wallet_score"
            ],
            "nullable": true
          },
          "mechanism": {
            "type": "string",
            "enum": [
              "stamps-api-v2"
            ],
            "nullable": true
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "score": {
            "type": "number",
            "nullable": true
          },
          "score_threshold": {
            "type": "number",
            "nullable": true
          },
          "passing_score": {
            "type": "boolean",
            "nullable": true
          },
          "last_score_timestamp": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "expiration_timestamp": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "stamps": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "object",
              "properties": {
                "stamp_name": {
                  "type": "string"
                },
                "stamp_score": {
                  "type": "number"
                }
              }
            }
          }
        }
      },
      "StartVerificationSessionRequest": {
        "type": "object",
        "required": [
          "provider"
        ],
        "description": "Start an interactive verification session for a provider that requires a frontend launch flow.\nThis surface is intentionally limited to interactive providers such as `self` and `very`.\nHuman Passport wallet-score refresh is not modeled as a verification session because it is\na server-side score lookup by address rather than a QR, widget, or redirect ceremony.\n\nThe server should treat this request as capability-driven. Clients should not ask the user to\nmanually choose raw Self disclosures such as `minimum_age` or `nationality`; the backend should\ncompile the provider-specific launch payload from the missing canonical capabilities and the\ncurrent product intent.\n",
        "properties": {
          "provider": {
            "type": "string",
            "enum": [
              "self",
              "very"
            ]
          },
          "provider_mode": {
            "type": "string",
            "enum": [
              "qr_deeplink",
              "widget"
            ],
            "nullable": true,
            "description": "Optional requested launch mode. `self` sessions resolve to `qr_deeplink`.\n`very` sessions resolve to `widget` in public v0.\n"
          },
          "requested_capabilities": {
            "type": "array",
            "minItems": 1,
            "items": {
              "$ref": "./verification.yaml#/RequestedVerificationCapability"
            },
            "description": "Capability set the session is intended to satisfy. The server owns the provider-specific\nverifier configuration and maps this request to an approved launch payload.\n\nPublic-v0 intent:\n- `very`: `unique_human` only\n- `self`: `unique_human`, `age_over_18`, `nationality`, and `gender` (document marker)\n\nWhen a Self session requests `age_over_18`, `nationality`, or `gender`, the server should\nalso treat `unique_human` as part of the effective capability set.\n"
          },
          "verification_requirements": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "./verification.yaml#/VerificationRequirement"
            },
            "description": "Additional typed verifier constraints for the requested capability set. Public v0 uses this\nto request a Self-backed `minimum_age` proof such as 21+ without encoding provider-specific\nverifier configuration in the client.\n"
          },
          "wallet_attachment_id": {
            "type": "string",
            "nullable": true
          },
          "verification_intent": {
            "$ref": "./verification.yaml#/VerificationIntent",
            "nullable": true,
            "description": "Product-flow identifier such as `profile_verification`, `community_creation`,\n`commerce_pricing`, or `qualifier_disclosure`.\n"
          },
          "policy_id": {
            "type": "string",
            "nullable": true,
            "description": "Optional server-defined verification policy identifier. When supplied, the server should\nuse this policy as the source of truth for provider-specific verifier settings rather than\ntrusting client-authored disclosure or widget configuration.\n"
          }
        }
      },
      "CompleteVerificationSessionRequest": {
        "type": "object",
        "description": "Provider-agnostic completion or refresh payload for an interactive verification session.\nFields are optional because some providers complete asynchronously while others return proof\nmaterial to the frontend first.\n",
        "properties": {
          "attestation_id": {
            "type": "string",
            "nullable": true
          },
          "proof": {
            "nullable": true,
            "oneOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "additionalProperties": true
              },
              {
                "type": "array",
                "items": {}
              }
            ],
            "description": "Provider proof material returned to the browser and forwarded to Pirate for final\nverification. Self proof payloads are SDK-owned JSON; Very proof payloads are usually\nstring material returned by the provider bridge.\n"
          },
          "proof_hash": {
            "type": "string",
            "nullable": true
          },
          "provider_payload_ref": {
            "nullable": true,
            "oneOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "additionalProperties": true
              }
            ],
            "description": "Opaque server-side reference to provider callback payload or proof material already stored\nby the backend.\n"
          }
        }
      },
      "ProviderVerificationCallbackRequest": {
        "type": "object",
        "description": "Generic callback envelope used by server-owned verification callback handlers.\nProviders may send raw proof material, redirect parameters, or opaque event data.\n",
        "properties": {
          "provider": {
            "type": "string",
            "enum": [
              "self",
              "very"
            ]
          },
          "event_type": {
            "type": "string",
            "nullable": true
          },
          "attestation_id": {
            "type": "string",
            "nullable": true
          },
          "proof_hash": {
            "type": "string",
            "nullable": true
          },
          "payload": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true,
            "description": "Opaque provider callback body as received or normalized by Pirate. Clients should not\ninfer a shared schema across providers.\nExamples:\n- `self`: relayer payloads may include fields such as `attestationId`, `proof`,\n  `publicSignals`, and `userContextData`\n- `very`: widget success payloads may include proof or result fields returned from the\n  provider-managed widget flow\n"
          }
        }
      },
      "SelfVerificationDisclosures": {
        "type": "object",
        "description": "Server-resolved disclosure and policy config for a Self launch payload.\nThis is backend-authored provider wiring, not a public community-settings surface.\nPublic-v0 community and join flows should primarily rely on:\n- `minimum_age`\n- `nationality`\n- `gender` (document marker)\n\nOther Self disclosure knobs remain modeled for future or operator-controlled use, but public-v0\nproduct flows should not expose raw Self `ofac` or `excluded_countries` settings as first-class\ncommunity toggles until Pirate locks their canonical capability and moderation semantics.\n",
        "properties": {
          "issuing_state": {
            "type": "boolean",
            "nullable": true
          },
          "name": {
            "type": "boolean",
            "nullable": true
          },
          "passport_number": {
            "type": "boolean",
            "nullable": true
          },
          "nationality": {
            "type": "boolean",
            "nullable": true
          },
          "date_of_birth": {
            "type": "boolean",
            "nullable": true
          },
          "gender": {
            "type": "boolean",
            "nullable": true
          },
          "expiry_date": {
            "type": "boolean",
            "nullable": true
          },
          "excluded_countries": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
          },
          "minimum_age": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "SelfVerificationLaunch": {
        "type": "object",
        "description": "Pirate's server-resolved Self launch payload. This is not a direct one-to-one mapping of the\nSelf SDK constructor; clients must map these fields to the SDK's expected parameters rather\nthan spreading this object directly into `SelfAppBuilder`.\n",
        "required": [
          "app_name",
          "endpoint",
          "endpoint_type",
          "scope",
          "session_id",
          "user_id",
          "user_id_type",
          "disclosures"
        ],
        "properties": {
          "app_name": {
            "type": "string"
          },
          "logo_base64": {
            "type": "string",
            "nullable": true
          },
          "header": {
            "type": "string",
            "nullable": true
          },
          "endpoint": {
            "type": "string"
          },
          "endpoint_type": {
            "type": "string",
            "enum": [
              "https",
              "staging_https",
              "celo",
              "staging_celo"
            ]
          },
          "scope": {
            "type": "string"
          },
          "session_id": {
            "type": "string"
          },
          "user_id": {
            "type": "string"
          },
          "user_id_type": {
            "type": "string",
            "enum": [
              "uuid",
              "hex"
            ]
          },
          "disclosures": {
            "$ref": "./verification.yaml#/SelfVerificationDisclosures"
          },
          "deeplink_callback": {
            "type": "string",
            "nullable": true
          },
          "version": {
            "type": "integer",
            "enum": [
              1,
              2
            ],
            "nullable": true
          },
          "user_defined_data": {
            "type": "string",
            "nullable": true
          },
          "chain_id": {
            "type": "integer",
            "nullable": true
          },
          "dev_mode": {
            "type": "boolean",
            "nullable": true
          }
        }
      },
      "VeryWidgetLaunch": {
        "type": "object",
        "required": [
          "app_id",
          "context",
          "type_id",
          "query",
          "verify_url"
        ],
        "properties": {
          "app_id": {
            "type": "string"
          },
          "context": {
            "type": "string"
          },
          "type_id": {
            "type": "string"
          },
          "query": {
            "type": "object",
            "additionalProperties": true,
            "description": "Opaque server-authored Very widget query payload for the current session. Clients should\npass this through to the provider widget rather than constructing or mutating it.\nExample shape may include `conditions` plus `options` such as\n`expiredAtLowerBound`, `externalNullifier`, `equalCheckId`, and `pseudonym`.\nFor unique-human verification, the server must use a stable Pirate uniqueness domain for\n`externalNullifier` and a per-session binding value for `pseudonym` or an equivalent\nproof-bound field, then verify both values before minting capabilities.\n"
          },
          "verify_url": {
            "type": "string"
          },
          "session_binding": {
            "$ref": "./verification.yaml#/VerySessionBinding"
          }
        }
      },
      "VerySessionBinding": {
        "type": "object",
        "required": [
          "uniqueness_domain",
          "binding_value",
          "challenge_expires_at"
        ],
        "description": "Server-authored binding material that the Very proof must cover. This separates the stable\nnullifier domain used for one-person-one-account enforcement from the per-session value used\nto prevent proof replay across verification sessions. For wallet-related flows this does not\nreplace wallet-signature ownership proof; it only binds the Very proof to the current Pirate\nverification ceremony.\n",
        "properties": {
          "uniqueness_domain": {
            "type": "string",
            "description": "Stable Very external-nullifier domain for the Pirate capability being minted."
          },
          "binding_value": {
            "type": "string",
            "description": "Server-generated per-session challenge, nonce, or hash included in the Very proof."
          },
          "binding_field": {
            "type": "string",
            "enum": [
              "pseudonym",
              "challenge"
            ],
            "nullable": true,
            "description": "Provider field used to carry the binding value."
          },
          "challenge_expires_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "VerificationSessionLaunch": {
        "type": "object",
        "required": [
          "mode"
        ],
        "description": "Frontend launch payload for an interactive verification session.\nExactly one provider-specific launch object should be present for a non-`none` mode.\n",
        "properties": {
          "mode": {
            "type": "string",
            "enum": [
              "qr_deeplink",
              "widget",
              "none"
            ]
          },
          "self_app": {
            "$ref": "./verification.yaml#/SelfVerificationLaunch"
          },
          "very_widget": {
            "$ref": "./verification.yaml#/VeryWidgetLaunch"
          }
        }
      },
      "AgentOwnershipProvider": {
        "type": "string",
        "enum": [
          "self_agent_id",
          "clawkey"
        ]
      },
      "AgentOwnershipSessionKind": {
        "type": "string",
        "enum": [
          "register",
          "refresh",
          "transfer",
          "deregister"
        ]
      },
      "AgentOwnershipSessionStatus": {
        "type": "string",
        "description": "Lifecycle status for a KYA ownership session. Implementations may fail fast from `pending`\nwhen the challenge, bootstrap conditions, or provider initialization fails before owner\nhandoff. Callback and explicit completion flows must be idempotent once a session reaches a\nterminal state.\n",
        "enum": [
          "pending",
          "awaiting_owner",
          "proof_submitted",
          "verified",
          "failed",
          "expired",
          "cancelled"
        ]
      },
      "UserAgentStatus": {
        "type": "string",
        "description": "Runtime status for a user-owned agent. Public v0 should prefer creating durable `user_agents`\nrows only after successful registration. If a server creates provisional `pending` rows\nearlier, they must not authorize reads or writes and should never survive as an active state\nafter the registration flow terminates.\n",
        "enum": [
          "pending",
          "active",
          "suspended",
          "revoked",
          "transferred",
          "deregistered"
        ]
      },
      "AgentHandleStatus": {
        "type": "string",
        "enum": [
          "active",
          "redirect",
          "retired"
        ]
      },
      "AgentOwnershipState": {
        "type": "string",
        "enum": [
          "pending",
          "verified",
          "expired",
          "revoked",
          "transferred"
        ]
      },
      "AgentChallenge": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "device_id",
          "public_key",
          "message",
          "signature",
          "timestamp"
        ],
        "description": "Agent-signed proof of key control used to start a KYA ownership session. The mainline\n`clawkey` provider uses a stable `device_id`, an Ed25519 public key encoded as base64 DER\nSPKI, a raw Ed25519 signature encoded as base64, and a unix-millisecond `timestamp`. Pirate\nverifies a fresh Ed25519 signature over the raw UTF-8 `message` bytes and rejects stale or\nfuture-skewed challenges outside the server freshness window.\n",
        "properties": {
          "device_id": {
            "type": "string",
            "description": "Stable device or agent identifier used by the ownership provider."
          },
          "public_key": {
            "type": "string",
            "description": "Ed25519 public key encoded as base64 DER SPKI without PEM wrapper."
          },
          "message": {
            "type": "string",
            "description": "Exact UTF-8 message that was signed."
          },
          "signature": {
            "type": "string",
            "description": "Raw Ed25519 signature encoded as base64."
          },
          "timestamp": {
            "type": "integer",
            "format": "int64",
            "description": "Unix timestamp in milliseconds when the challenge was created."
          }
        }
      },
      "AgentActionProof": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "nonce",
          "signed_at",
          "canonical_request_hash",
          "signature"
        ],
        "description": "Agent-signed request proof bound to the current write. The server must recompute\n`canonical_request_hash` from the request according to Pirate's canonical request hashing\nmini-spec, verify the signature against the active agent key material, and reject replays of\nthe same `(agent_id, nonce)` pair. The canonicalization contract must define path\nnormalization, query handling, body serialization, the empty-body rule, UTF-8 encoding, and\ndigest output so clients and the server produce the same hash. When the request body carries\nthe proof envelope itself, the proof field is excluded from canonicalization; public v0\nexcludes `CreatePostRequest.agent_action_proof`. Pirate v0 also defines the signature payload\ncontract in `specs/domain/agent-action-proof.md`: Ed25519 over the newline-delimited\n`pirate-agent-action-signature-v1`, `nonce`, `signed_at`, and `canonical_request_hash`\npayload, using the active ownership record's SPKI PEM public key.\n",
        "properties": {
          "nonce": {
            "type": "string"
          },
          "signed_at": {
            "type": "string",
            "format": "date-time"
          },
          "canonical_request_hash": {
            "type": "string",
            "description": "Digest of the canonicalized request that the agent signed. This field is intentionally\nalgorithm-agnostic in the schema, but implementations must follow Pirate's published\ncanonical request hashing mini-spec rather than inventing provider- or client-local rules.\nPirate v0 currently anchors that contract in `specs/domain/agent-action-proof.md`.\n"
          },
          "signature": {
            "type": "string"
          }
        }
      },
      "SelfAgentOwnershipLaunch": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "deep_link": {
            "type": "string",
            "nullable": true
          },
          "qr_ref": {
            "type": "string",
            "nullable": true
          },
          "session_token_ref": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "ClawkeyRegistrationLaunch": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "session_id",
          "registration_url"
        ],
        "properties": {
          "session_id": {
            "type": "string"
          },
          "registration_url": {
            "type": "string"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "AgentOwnershipSessionLaunch": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "mode"
        ],
        "properties": {
          "mode": {
            "type": "string",
            "enum": [
              "qr_deeplink",
              "registration_url",
              "none"
            ]
          },
          "self_agent": {
            "$ref": "./agents.yaml#/SelfAgentOwnershipLaunch"
          },
          "clawkey_registration": {
            "$ref": "./agents.yaml#/ClawkeyRegistrationLaunch"
          }
        }
      },
      "StartAgentOwnershipSessionRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "session_kind",
          "ownership_provider",
          "agent_challenge"
        ],
        "description": "Start a KYA-backed agent ownership session. `register` may omit `agent_id` when creating a\nnew user-owned agent. `refresh`, `transfer`, and `deregister` require an existing `agent_id`.\n`display_name` is an optional requested initial name for registration flows. `policy_id` is an\noptional server policy lookup key for provider-specific session configuration and must not act\nas an authorization bypass around community or platform trust rules. The mainline public\nprovider flow is `clawkey`, which expects the ClawKey challenge contract and returns a\nregistration URL for the human owner to open manually.\n",
        "properties": {
          "session_kind": {
            "$ref": "./agents.yaml#/AgentOwnershipSessionKind"
          },
          "ownership_provider": {
            "$ref": "./agents.yaml#/AgentOwnershipProvider"
          },
          "agent_id": {
            "type": "string",
            "nullable": true
          },
          "display_name": {
            "type": "string",
            "nullable": true,
            "description": "Optional requested display name for `register`. Servers may ignore this field for\n`refresh` and `deregister` unless the provider flow requires name continuity or review.\n"
          },
          "policy_id": {
            "type": "string",
            "nullable": true,
            "description": "Optional policy lookup key that selects provider-specific verifier settings or ownership\nflow configuration at session start. The server must still enforce platform and community\ntrust policy independently of this field.\n"
          },
          "agent_challenge": {
            "$ref": "./agents.yaml#/AgentChallenge"
          }
        }
      },
      "CompleteAgentOwnershipSessionRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "attestation_id": {
            "type": "string",
            "nullable": true
          },
          "proof_hash": {
            "type": "string",
            "nullable": true
          },
          "provider_payload_ref": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "ProviderAgentOwnershipCallbackRequest": {
        "type": "object",
        "additionalProperties": false,
        "description": "Provider-delivered callback payload for an ownership session. The callback transport may be\npublicly reachable, but the runtime must authenticate the caller using the expected provider's\nsecret or verification method associated with the stored session. The `provider` field in this\nbody is advisory only and must not be trusted by itself. Providers may retry callbacks, so\nduplicate deliveries must be handled idempotently. Mainline `clawkey` ownership should be\ntreated as polling-first; callback support is optional and provider-specific.\n",
        "properties": {
          "provider": {
            "$ref": "./agents.yaml#/AgentOwnershipProvider"
          },
          "event_type": {
            "type": "string",
            "nullable": true
          },
          "attestation_id": {
            "type": "string",
            "nullable": true
          },
          "proof_hash": {
            "type": "string",
            "nullable": true
          },
          "payload": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          }
        }
      },
      "AgentOwnershipRecord": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "agent_ownership_record_id",
          "agent_id",
          "owner_user_id",
          "ownership_provider",
          "ownership_state",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "agent_ownership_record_id": {
            "type": "string"
          },
          "agent_id": {
            "type": "string"
          },
          "owner_user_id": {
            "type": "string"
          },
          "ownership_provider": {
            "$ref": "./agents.yaml#/AgentOwnershipProvider"
          },
          "provider_subject_id": {
            "type": "string",
            "nullable": true
          },
          "device_id": {
            "type": "string",
            "nullable": true
          },
          "public_key": {
            "type": "string",
            "nullable": true
          },
          "ownership_state": {
            "$ref": "./agents.yaml#/AgentOwnershipState"
          },
          "source_session_id": {
            "type": "string",
            "nullable": true,
            "description": "Internal audit anchor for the ownership session that created or last transitioned this\nrecord. This may be null on legacy or backfilled records.\n"
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "expires_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "ended_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "evidence_ref": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "AgentOwnershipSession": {
        "type": "object",
        "additionalProperties": false,
        "description": "KYA ownership session state tracked by Pirate while a provider-backed registration, refresh,\ntransfer, or deregistration flow is in progress or has recently completed.\n",
        "required": [
          "agent_ownership_session_id",
          "session_kind",
          "ownership_provider",
          "status",
          "launch",
          "created_at",
          "expires_at",
          "updated_at"
        ],
        "properties": {
          "agent_ownership_session_id": {
            "type": "string"
          },
          "session_kind": {
            "$ref": "./agents.yaml#/AgentOwnershipSessionKind"
          },
          "owner_user_id": {
            "type": "string",
            "nullable": true,
            "description": "May be null while Pirate is still resolving the human owner, such as agent-initiated\nstarts or transfer handoff flows. A session must not transition to `verified` until the\neffective owner is known.\n"
          },
          "agent_id": {
            "type": "string",
            "nullable": true
          },
          "ownership_provider": {
            "$ref": "./agents.yaml#/AgentOwnershipProvider"
          },
          "status": {
            "$ref": "./agents.yaml#/AgentOwnershipSessionStatus"
          },
          "agent_challenge_ref": {
            "type": "string"
          },
          "provider_session_ref": {
            "type": "string",
            "nullable": true
          },
          "launch": {
            "$ref": "./agents.yaml#/AgentOwnershipSessionLaunch"
          },
          "callback_path": {
            "type": "string",
            "nullable": true,
            "description": "Public callback endpoint for provider delivery when the selected provider uses asynchronous\ncompletion. Runtime callers must still authenticate the provider separately from transport-\nlevel auth, and duplicate callback deliveries must be idempotent.\n"
          },
          "resolved_agent_ownership_record_id": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "AgentDelegatedCredentialIssueRequest": {
        "type": "object",
        "additionalProperties": false,
        "description": "Optional delegated credential issuance hints for the authenticated owner. Public v0 should\nissue an opaque bearer access token plus refresh token after re-checking owner standing,\nactive ownership, and KYA baseline. Internal-only milestones may temporarily reuse the owner's\nordinary Pirate bearer token while validating KYA enforcement, but that does not count as this\npublic delegated credential contract.\n",
        "properties": {
          "current_ownership_record_id": {
            "type": "string",
            "nullable": true,
            "description": "Optional optimistic concurrency hint for the ownership interval the caller believes is\nactive. Servers must still resolve the actual active verified ownership interval and reject\nissuance if the hint is stale or mismatched.\n"
          }
        }
      },
      "AgentDelegatedCredentialRefreshRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "refresh_token"
        ],
        "description": "Refresh request for an existing delegated agent credential. Refresh must fail when the owner no\nlonger satisfies standing requirements, the active ownership interval is no longer valid, or\nKYA verification has lapsed.\n",
        "properties": {
          "refresh_token": {
            "type": "string"
          }
        }
      },
      "AgentDelegatedCredential": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "agent_id",
          "owner_user_id",
          "current_ownership_record_id",
          "token_type",
          "access_token",
          "refresh_token",
          "issued_at",
          "expires_at"
        ],
        "description": "Delegated agent API credential issued to the authenticated owner for a specific user-owned\nagent. Public v0 should prefer opaque bearer tokens over long-lived self-contained JWTs so\nrefresh denial remains the primary revocation chokepoint.\n",
        "properties": {
          "agent_id": {
            "type": "string"
          },
          "owner_user_id": {
            "type": "string"
          },
          "current_ownership_record_id": {
            "type": "string",
            "description": "Ownership interval the credential was issued against. Historical writes still carry their\nown `agent_ownership_record_id` snapshots and must not rely on the current token state.\n"
          },
          "token_type": {
            "type": "string",
            "enum": [
              "Bearer"
            ]
          },
          "access_token": {
            "type": "string"
          },
          "refresh_token": {
            "type": "string"
          },
          "issued_at": {
            "type": "string",
            "format": "date-time"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          },
          "refresh_expires_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "UserReportReasonCode": {
        "type": "string",
        "enum": [
          "spam",
          "harassment",
          "hate",
          "sexual_content",
          "graphic_content",
          "misleading",
          "other"
        ]
      },
      "ModerationActionType": {
        "type": "string",
        "enum": [
          "dismiss",
          "hide",
          "remove",
          "restore",
          "age_gate"
        ]
      },
      "ModerationSignal": {
        "type": "object",
        "required": [
          "moderation_signal_id",
          "community_id",
          "post_id",
          "comment_id",
          "analysis_result_ref",
          "source",
          "signal_type",
          "severity",
          "provider",
          "provider_label",
          "created_at"
        ],
        "properties": {
          "moderation_signal_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "post_id": {
            "type": "string",
            "nullable": true
          },
          "comment_id": {
            "type": "string",
            "nullable": true
          },
          "analysis_result_ref": {
            "type": "string",
            "nullable": true
          },
          "source": {
            "type": "string",
            "enum": [
              "platform_analysis"
            ]
          },
          "signal_type": {
            "type": "string"
          },
          "severity": {
            "$ref": "./moderation.yaml#/ModerationSignalSeverity"
          },
          "provider": {
            "type": "string"
          },
          "provider_label": {
            "type": "string"
          },
          "evidence_ref": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "UserReport": {
        "type": "object",
        "required": [
          "user_report_id",
          "community_id",
          "post_id",
          "comment_id",
          "reporter_user_id",
          "reason_code",
          "created_at"
        ],
        "properties": {
          "user_report_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "post_id": {
            "type": "string",
            "nullable": true
          },
          "comment_id": {
            "type": "string",
            "nullable": true
          },
          "reporter_user_id": {
            "type": "string"
          },
          "reason_code": {
            "$ref": "./moderation.yaml#/UserReportReasonCode"
          },
          "note": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "ModerationAction": {
        "type": "object",
        "required": [
          "moderation_action_id",
          "moderation_case_id",
          "community_id",
          "post_id",
          "comment_id",
          "actor_user_id",
          "action_type",
          "created_at"
        ],
        "properties": {
          "moderation_action_id": {
            "type": "string"
          },
          "moderation_case_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "post_id": {
            "type": "string",
            "nullable": true
          },
          "comment_id": {
            "type": "string",
            "nullable": true
          },
          "actor_user_id": {
            "type": "string"
          },
          "action_type": {
            "$ref": "./moderation.yaml#/ModerationActionType"
          },
          "note": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "ModerationCase": {
        "type": "object",
        "required": [
          "moderation_case_id",
          "community_id",
          "post_id",
          "comment_id",
          "status",
          "queue_scope",
          "priority",
          "opened_by",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "moderation_case_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "post_id": {
            "type": "string",
            "nullable": true
          },
          "comment_id": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "$ref": "./moderation.yaml#/ModerationCaseStatus"
          },
          "queue_scope": {
            "$ref": "./moderation.yaml#/ModerationQueueScope"
          },
          "priority": {
            "$ref": "./moderation.yaml#/ModerationSignalSeverity"
          },
          "opened_by": {
            "$ref": "./moderation.yaml#/ModerationCaseOpenedBy"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          },
          "resolved_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "ModerationCaseDetail": {
        "type": "object",
        "required": [
          "case",
          "post",
          "comment",
          "signals",
          "reports",
          "actions"
        ],
        "properties": {
          "case": {
            "$ref": "./moderation.yaml#/ModerationCase"
          },
          "post": {
            "$ref": "./posts.yaml#/Post",
            "nullable": true
          },
          "comment": {
            "$ref": "./comments.yaml#/Comment",
            "nullable": true
          },
          "signals": {
            "type": "array",
            "items": {
              "$ref": "./moderation.yaml#/ModerationSignal"
            }
          },
          "reports": {
            "type": "array",
            "items": {
              "$ref": "./moderation.yaml#/UserReport"
            }
          },
          "actions": {
            "type": "array",
            "items": {
              "$ref": "./moderation.yaml#/ModerationAction"
            }
          }
        }
      },
      "ModerationCaseListResponse": {
        "type": "object",
        "required": [
          "items"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./moderation.yaml#/ModerationCase"
            }
          }
        }
      },
      "CreateUserReportRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "reason_code"
        ],
        "properties": {
          "reason_code": {
            "$ref": "./moderation.yaml#/UserReportReasonCode"
          },
          "note": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CreateModerationActionRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "action_type"
        ],
        "properties": {
          "action_type": {
            "$ref": "./moderation.yaml#/ModerationActionType"
          },
          "note": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "UserAgent": {
        "type": "object",
        "additionalProperties": false,
        "description": "User-owned agent read model. An agent becomes operational only when it has an active verified\nownership interval; provisional `pending` rows, if they exist at all, are non-authorizing.\n",
        "required": [
          "agent_id",
          "owner_user_id",
          "display_name",
          "status",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "agent_id": {
            "type": "string"
          },
          "owner_user_id": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "handle": {
            "$ref": "./agents.yaml#/AgentHandle",
            "nullable": true
          },
          "status": {
            "$ref": "./agents.yaml#/UserAgentStatus"
          },
          "current_ownership_record_id": {
            "type": "string",
            "nullable": true,
            "description": "Present only when the agent currently has an active verified ownership interval.\n"
          },
          "current_ownership": {
            "$ref": "./agents.yaml#/AgentOwnershipRecord",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "UserAgentListResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./agents.yaml#/UserAgent"
            }
          }
        }
      },
      "AgentHandle": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "agent_handle_id",
          "agent_id",
          "label_normalized",
          "label_display",
          "status",
          "issued_at",
          "created_at",
          "updated_at"
        ],
        "description": "Canonical platform-issued handle for a user-owned agent under the managed `.clawitzer` root.\nA user-owned agent may have one active handle. Replaced labels may remain as redirects.\n",
        "properties": {
          "agent_handle_id": {
            "type": "string"
          },
          "agent_id": {
            "type": "string"
          },
          "label_normalized": {
            "type": "string",
            "description": "Lowercase `.clawitzer` label without the root suffix."
          },
          "label_display": {
            "type": "string",
            "description": "Display handle including the `.clawitzer` suffix."
          },
          "status": {
            "$ref": "./agents.yaml#/AgentHandleStatus"
          },
          "redirect_target_agent_handle_id": {
            "type": "string",
            "nullable": true
          },
          "issued_at": {
            "type": "string",
            "format": "date-time"
          },
          "replaced_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "UpdateAgentHandleRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "desired_label"
        ],
        "properties": {
          "desired_label": {
            "type": "string",
            "description": "Desired `.clawitzer` label, accepted with or without the root suffix."
          }
        }
      },
      "UpdateUserAgentRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "display_name"
        ],
        "properties": {
          "display_name": {
            "type": "string",
            "description": "Requested display name for the user-owned agent."
          }
        }
      },
      "PublicAgentResolution": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "is_canonical",
          "requested_handle_label",
          "resolved_handle_label",
          "agent",
          "owner"
        ],
        "properties": {
          "is_canonical": {
            "type": "boolean"
          },
          "requested_handle_label": {
            "type": "string"
          },
          "resolved_handle_label": {
            "type": "string"
          },
          "agent": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "agent_id",
              "handle",
              "created_at",
              "updated_at"
            ],
            "properties": {
              "agent_id": {
                "type": "string"
              },
              "display_name": {
                "type": "string",
                "nullable": true
              },
              "handle": {
                "$ref": "./agents.yaml#/AgentHandle"
              },
              "ownership_provider": {
                "$ref": "./agents.yaml#/AgentOwnershipProvider",
                "nullable": true
              },
              "created_at": {
                "type": "string",
                "format": "date-time"
              },
              "updated_at": {
                "type": "string",
                "format": "date-time"
              }
            }
          },
          "owner": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "user_id",
              "global_handle",
              "primary_public_handle"
            ],
            "properties": {
              "user_id": {
                "type": "string"
              },
              "display_name": {
                "type": "string",
                "nullable": true
              },
              "global_handle": {
                "$ref": "./profiles.yaml#/GlobalHandle"
              },
              "primary_public_handle": {
                "$ref": "./profiles.yaml#/LinkedHandle",
                "nullable": true
              }
            }
          }
        }
      },
      "Profile": {
        "type": "object",
        "required": [
          "user_id",
          "global_handle",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "user_id": {
            "type": "string"
          },
          "display_name": {
            "type": "string",
            "nullable": true
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "avatar_source": {
            "type": "string",
            "enum": [
              "ens",
              "upload",
              "none"
            ],
            "nullable": true
          },
          "cover_ref": {
            "type": "string",
            "nullable": true
          },
          "cover_source": {
            "type": "string",
            "enum": [
              "ens",
              "upload",
              "none"
            ],
            "nullable": true
          },
          "bio": {
            "type": "string",
            "nullable": true
          },
          "bio_source": {
            "type": "string",
            "enum": [
              "ens",
              "manual",
              "none"
            ],
            "nullable": true
          },
          "preferred_locale": {
            "type": "string",
            "nullable": true
          },
          "display_verified_nationality_badge": {
            "type": "boolean",
            "nullable": true
          },
          "nationality_badge_country": {
            "type": "string",
            "nullable": true
          },
          "linked_handles": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "./profiles.yaml#/LinkedHandle"
            }
          },
          "primary_public_handle": {
            "allOf": [
              {
                "$ref": "./profiles.yaml#/LinkedHandle"
              }
            ],
            "nullable": true
          },
          "primary_wallet_address": {
            "type": "string",
            "nullable": true,
            "description": "Public primary wallet address when Pirate product policy exposes wallet-linked identity on profile."
          },
          "xmtp_inbox_id": {
            "type": "string",
            "nullable": true,
            "description": "Optional published XMTP inbox ID for direct profile messaging. This is populated only after the user opts in to encrypted chat identity publication."
          },
          "verification_capabilities": {
            "allOf": [
              {
                "$ref": "./verification.yaml#/VerificationCapabilities"
              }
            ],
            "nullable": true,
            "description": "Public normalized trust projection shown on profile when Pirate enables public trust fields."
          },
          "global_handle": {
            "$ref": "./profiles.yaml#/GlobalHandle"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "GlobalHandle": {
        "type": "object",
        "required": [
          "global_handle_id",
          "label",
          "tier",
          "status",
          "issuance_source",
          "issued_at"
        ],
        "properties": {
          "global_handle_id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "tier": {
            "type": "string",
            "enum": [
              "generated",
              "standard",
              "premium"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "redirect",
              "retired"
            ]
          },
          "issuance_source": {
            "type": "string",
            "enum": [
              "generated_signup",
              "free_cleanup_rename",
              "reddit_verified_claim",
              "paid_upgrade",
              "admin_grant"
            ]
          },
          "redirect_target_global_handle_id": {
            "type": "string",
            "nullable": true
          },
          "price_paid_usd": {
            "type": "number",
            "nullable": true
          },
          "free_rename_consumed": {
            "type": "boolean"
          },
          "issued_at": {
            "type": "string",
            "format": "date-time"
          },
          "replaced_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "HandleUpgradeQuote": {
        "type": "object",
        "required": [
          "desired_label",
          "tier",
          "price_usd",
          "eligible"
        ],
        "properties": {
          "desired_label": {
            "type": "string"
          },
          "tier": {
            "type": "string",
            "enum": [
              "standard",
              "premium"
            ]
          },
          "price_usd": {
            "type": "number"
          },
          "eligible": {
            "type": "boolean"
          },
          "reason": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "VerificationSession": {
        "type": "object",
        "required": [
          "verification_session_id",
          "user_id",
          "provider",
          "requested_capabilities",
          "status",
          "created_at",
          "expires_at"
        ],
        "properties": {
          "verification_session_id": {
            "type": "string"
          },
          "user_id": {
            "type": "string"
          },
          "provider": {
            "type": "string",
            "enum": [
              "self",
              "very"
            ],
            "description": "Interactive provider family for this session. Human Passport wallet-score lookups are\nintentionally excluded because they do not require a session ceremony.\n"
          },
          "provider_mode": {
            "type": "string",
            "enum": [
              "qr_deeplink",
              "widget"
            ],
            "nullable": true
          },
          "wallet_attachment_id": {
            "type": "string",
            "nullable": true
          },
          "requested_capabilities": {
            "type": "array",
            "items": {
              "$ref": "./verification.yaml#/RequestedVerificationCapability"
            }
          },
          "verification_requirements": {
            "type": "array",
            "items": {
              "$ref": "./verification.yaml#/VerificationRequirement"
            }
          },
          "verification_intent": {
            "$ref": "./verification.yaml#/VerificationIntent",
            "nullable": true
          },
          "policy_id": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "verified",
              "failed",
              "expired"
            ]
          },
          "launch": {
            "$ref": "./verification.yaml#/VerificationSessionLaunch"
          },
          "callback_path": {
            "type": "string",
            "nullable": true,
            "description": "Server-owned completion path for the session. Clients may treat this as informational.\n"
          },
          "nationality": {
            "type": "string",
            "nullable": true
          },
          "age_at_verification": {
            "type": "integer",
            "nullable": true
          },
          "attestation_id": {
            "type": "string",
            "nullable": true
          },
          "proof_hash": {
            "type": "string",
            "nullable": true
          },
          "evidence_ref": {
            "type": "string",
            "nullable": true
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "failure_reason": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "StartNamespaceVerificationSessionRequest": {
        "type": "object",
        "required": [
          "family",
          "root_label"
        ],
        "properties": {
          "family": {
            "type": "string",
            "enum": [
              "hns",
              "spaces"
            ],
            "description": "Public v0 supports HNS and Spaces. Future namespace families may extend this surface without changing the session model.\n"
          },
          "root_label": {
            "type": "string",
            "description": "Root label as entered by the creator before server normalization."
          }
        }
      },
      "CompleteNamespaceVerificationSessionRequest": {
        "type": "object",
        "description": "Trigger a refresh of challenge observations and assertion derivation after the creator has completed the required proof step. The body is optional because many implementations can treat this as an idempotent recheck.\n",
        "properties": {
          "restart_challenge": {
            "type": "boolean",
            "nullable": true,
            "description": "Optional hint to invalidate the current challenge and issue a new one if the creator wants to restart the proof flow.\n"
          }
        }
      },
      "NamespaceVerificationAssertions": {
        "type": "object",
        "description": "Accepted or in-flight namespace assertions derived from the current evidence bundle. These facts remain distinct so attach capability, routing capability, live root-key control, and protocol-specific managed-issuance capability are not collapsed into one flag.\n",
        "properties": {
          "root_exists": {
            "type": "boolean",
            "nullable": true
          },
          "root_control_verified": {
            "type": "boolean",
            "nullable": true
          },
          "expiry_horizon_sufficient": {
            "type": "boolean",
            "nullable": true
          },
          "routing_enabled": {
            "type": "boolean",
            "nullable": true
          },
          "pirate_dns_authority_verified": {
            "type": "boolean",
            "nullable": true
          },
          "root_key_proof_verified": {
            "type": "boolean",
            "nullable": true
          },
          "fabric_publish_verified": {
            "type": "boolean",
            "nullable": true
          },
          "anchor_fresh_enough": {
            "type": "boolean",
            "nullable": true
          },
          "owner_signed_updates_verified": {
            "type": "boolean",
            "nullable": true
          }
        }
      },
      "NamespaceVerificationCapabilities": {
        "type": "object",
        "description": "Derived capabilities from the current accepted assertions. These are technical capability outputs, not automatic product permission for namespace commerce.\n",
        "properties": {
          "club_attach_allowed": {
            "type": "boolean",
            "nullable": true
          },
          "pirate_web_routing_allowed": {
            "type": "boolean",
            "nullable": true
          },
          "pirate_subdomain_issuance_allowed": {
            "type": "boolean",
            "nullable": true
          },
          "owner_signed_record_updates_allowed": {
            "type": "boolean",
            "nullable": true
          },
          "pirate_subspace_issuance_allowed": {
            "type": "boolean",
            "nullable": true
          }
        }
      },
      "NamespaceVerificationSession": {
        "type": "object",
        "required": [
          "namespace_verification_session_id",
          "user_id",
          "family",
          "submitted_root_label",
          "status",
          "created_at",
          "expires_at"
        ],
        "properties": {
          "namespace_verification_session_id": {
            "type": "string"
          },
          "namespace_verification_id": {
            "type": "string",
            "nullable": true,
            "description": "Populated only when the session reaches `verified` and Pirate has issued an accepted verification reference.\n"
          },
          "user_id": {
            "type": "string"
          },
          "family": {
            "type": "string",
            "enum": [
              "hns",
              "spaces"
            ]
          },
          "submitted_root_label": {
            "type": "string"
          },
          "normalized_root_label": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "inspecting",
              "dns_setup_required",
              "challenge_required",
              "challenge_pending",
              "verifying",
              "verified",
              "failed",
              "expired",
              "disputed"
            ],
            "description": "Shared namespace-verification session status.\n`dns_setup_required` is HNS-only and should not be used for Spaces sessions.\n"
          },
          "challenge_kind": {
            "type": "string",
            "enum": [
              "dns_txt",
              "fabric_txt_publish"
            ],
            "nullable": true,
            "description": "Family-specific challenge type for the current session.\n`dns_txt` is used by HNS-style TXT proof flows.\n`fabric_txt_publish` is used by Spaces Fabric publish proof flows.\n"
          },
          "challenge_host": {
            "type": "string",
            "nullable": true,
            "description": "Explicit record host for DNS TXT flows such as `_pirate.<root>`.\n"
          },
          "challenge_txt_value": {
            "type": "string",
            "nullable": true,
            "description": "Exact TXT content Pirate expects for DNS TXT verification flows.\n"
          },
          "challenge_payload": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true,
            "description": "Family-specific challenge payload.\nExample HNS payload fields may include `host` and `txt_value`.\nExample Spaces payload fields may include `message`, `digest`, and signer metadata.\n"
          },
          "challenge_expires_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true,
            "description": "Expiration time for the currently issued challenge, distinct from the overall namespace verification session expiry."
          },
          "setup_nameservers": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            },
            "description": "Nameservers the user should publish for the Pirate-managed HNS path before TXT verification can continue.\n"
          },
          "assertions": {
            "allOf": [
              {
                "$ref": "./verification.yaml#/NamespaceVerificationAssertions"
              }
            ],
            "nullable": true
          },
          "capabilities": {
            "allOf": [
              {
                "$ref": "./verification.yaml#/NamespaceVerificationCapabilities"
              }
            ],
            "nullable": true
          },
          "control_class": {
            "type": "string",
            "enum": [
              "single_holder_root",
              "multisig_controlled_root",
              "dao_controlled_root",
              "burned_or_immutable_root"
            ],
            "nullable": true
          },
          "operation_class": {
            "type": "string",
            "enum": [
              "owner_managed_namespace",
              "routing_only_namespace",
              "pirate_delegated_namespace",
              "owner_signed_updates_namespace"
            ],
            "nullable": true
          },
          "observation_provider": {
            "type": "string",
            "nullable": true,
            "description": "Trusted provider used for the most recent accepted namespace-verification observation in public v0.\n"
          },
          "evidence_bundle_ref": {
            "type": "string",
            "nullable": true
          },
          "failure_reason": {
            "type": "string",
            "nullable": true
          },
          "accepted_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "NamespaceVerification": {
        "type": "object",
        "required": [
          "namespace_verification_id",
          "user_id",
          "family",
          "normalized_root_label",
          "status",
          "assertions",
          "capabilities",
          "accepted_at",
          "expires_at",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "namespace_verification_id": {
            "type": "string"
          },
          "user_id": {
            "type": "string"
          },
          "family": {
            "type": "string",
            "enum": [
              "hns",
              "spaces"
            ]
          },
          "normalized_root_label": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "verified",
              "stale",
              "expired",
              "disputed"
            ]
          },
          "assertions": {
            "$ref": "./verification.yaml#/NamespaceVerificationAssertions"
          },
          "capabilities": {
            "$ref": "./verification.yaml#/NamespaceVerificationCapabilities"
          },
          "control_class": {
            "type": "string",
            "enum": [
              "single_holder_root",
              "multisig_controlled_root",
              "dao_controlled_root",
              "burned_or_immutable_root"
            ],
            "nullable": true
          },
          "operation_class": {
            "type": "string",
            "enum": [
              "owner_managed_namespace",
              "routing_only_namespace",
              "pirate_delegated_namespace",
              "owner_signed_updates_namespace"
            ],
            "nullable": true
          },
          "observation_provider": {
            "type": "string",
            "nullable": true
          },
          "evidence_bundle_ref": {
            "type": "string",
            "nullable": true
          },
          "accepted_at": {
            "type": "string",
            "format": "date-time"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "RedditVerification": {
        "type": "object",
        "required": [
          "reddit_username",
          "status"
        ],
        "properties": {
          "reddit_username": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "verified",
              "failed",
              "expired"
            ]
          },
          "verification_hint": {
            "type": "string",
            "nullable": true,
            "description": "Human-readable code placement instruction or verification code handoff for the current pending session.\n"
          },
          "code_placement_surface": {
            "type": "string",
            "nullable": true,
            "enum": [
              "profile",
              "bio",
              "about"
            ]
          },
          "last_checked_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "failure_code": {
            "type": "string",
            "nullable": true,
            "enum": [
              "code_not_found",
              "username_not_found",
              "rate_limited",
              "source_error"
            ]
          }
        }
      },
      "RedditImportSummary": {
        "type": "object",
        "required": [
          "reddit_username",
          "imported_at",
          "top_subreddits",
          "moderator_of",
          "inferred_interests",
          "suggested_communities"
        ],
        "properties": {
          "reddit_username": {
            "type": "string"
          },
          "imported_at": {
            "type": "string",
            "format": "date-time"
          },
          "account_age_days": {
            "type": "integer",
            "nullable": true
          },
          "imported_reddit_score": {
            "type": "integer",
            "nullable": true
          },
          "global_karma": {
            "type": "integer",
            "nullable": true,
            "deprecated": true,
            "description": "Use `imported_reddit_score`."
          },
          "top_subreddits": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "subreddit"
              ],
              "properties": {
                "subreddit": {
                  "type": "string"
                },
                "karma": {
                  "type": "integer",
                  "nullable": true
                },
                "posts": {
                  "type": "integer",
                  "nullable": true
                },
                "rank_source": {
                  "type": "string",
                  "nullable": true,
                  "enum": [
                    "karma",
                    "posts",
                    "source_order"
                  ]
                }
              }
            }
          },
          "moderator_of": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "inferred_interests": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "suggested_communities": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "community_id",
                "name",
                "reason"
              ],
              "properties": {
                "community_id": {
                  "type": "string"
                },
                "name": {
                  "type": "string"
                },
                "reason": {
                  "type": "string"
                }
              }
            }
          },
          "coverage_note": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "OnboardingStatus": {
        "type": "object",
        "required": [
          "generated_handle_assigned",
          "cleanup_rename_available",
          "unique_human_verification_status",
          "namespace_verification_status",
          "community_creation_ready",
          "missing_requirements",
          "reddit_verification_status",
          "reddit_import_status"
        ],
        "properties": {
          "generated_handle_assigned": {
            "type": "boolean"
          },
          "cleanup_rename_available": {
            "type": "boolean"
          },
          "onboarding_dismissed_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "unique_human_verification_status": {
            "type": "string",
            "enum": [
              "not_started",
              "pending",
              "verified",
              "expired",
              "failed"
            ]
          },
          "namespace_verification_status": {
            "type": "string",
            "enum": [
              "not_started",
              "pending",
              "verified",
              "stale",
              "expired",
              "disputed",
              "failed"
            ]
          },
          "community_creation_ready": {
            "type": "boolean"
          },
          "missing_requirements": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "reddit_verification_status": {
            "type": "string",
            "enum": [
              "not_started",
              "pending",
              "verified",
              "failed"
            ]
          },
          "reddit_import_status": {
            "type": "string",
            "enum": [
              "not_started",
              "queued",
              "running",
              "succeeded",
              "failed"
            ]
          },
          "suggested_community_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      "WalletAttachmentSummary": {
        "type": "object",
        "required": [
          "wallet_attachment_id",
          "chain_namespace",
          "wallet_address",
          "is_primary"
        ],
        "properties": {
          "wallet_attachment_id": {
            "type": "string"
          },
          "chain_namespace": {
            "type": "string"
          },
          "wallet_address": {
            "type": "string"
          },
          "is_primary": {
            "type": "boolean"
          }
        }
      },
      "CreateCommunityRequestBase": {
        "type": "object",
        "description": "Authoritative community-create write model. When `namespace` is provided for namespace-backed communities in public v0, the server must resolve `namespace.namespace_verification_id` to the accepted namespace-verification object at create time and re-check creator binding, freshness, and `club_attach_allowed` before any community state is written. When `namespace` is omitted, the community is created without a namespace and can attach one later.\n",
        "required": [
          "display_name",
          "membership_mode",
          "allow_anonymous_identity",
          "handle_policy"
        ],
        "properties": {
          "display_name": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "database_region": {
            "type": "string",
            "nullable": true,
            "enum": [
              "auto",
              "aws-us-east-1",
              "aws-us-east-2",
              "aws-us-west-2",
              "aws-eu-west-1",
              "aws-ap-south-1",
              "aws-ap-northeast-1"
            ],
            "description": "Create-time primary Turso group location for the community database. `auto` or omission\nlets the server use its configured default. Explicit values must be present in the\nserver-side allowed location list and should be treated as difficult to change after\ncreation because the region choice defines the community's initial data-residency boundary.\n"
          },
          "localized_text": {
            "$ref": "./communities-core.yaml#/CommunityTextLocalization",
            "nullable": true
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "banner_ref": {
            "type": "string",
            "nullable": true
          },
          "artist_identity_id": {
            "type": "string",
            "nullable": true
          },
          "membership_mode": {
            "type": "string",
            "enum": [
              "open",
              "request",
              "gated"
            ],
            "description": "Public v0 community creation should submit only `open` or `gated`. `request` remains in the model for deferred, internal, or later use and should not be exposed by the public create client.\n"
          },
          "allow_anonymous_identity": {
            "type": "boolean"
          },
          "anonymous_identity_scope": {
            "type": "string",
            "enum": [
              "community_stable",
              "thread_stable",
              "post_ephemeral"
            ],
            "nullable": true,
            "description": "Required when `allow_anonymous_identity = true`. Public v0 should default to `community_stable`. `post_ephemeral` must not be submitted in the public v0 create flow unless all prerequisites from the domain spec (active content safety classification, at least one active moderator) can be verified at create time.\n"
          },
          "allowed_disclosed_qualifiers": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true,
            "description": "Array of platform-defined `qualifier_template_id` values. Public v0 create may set this when `allow_anonymous_identity = true`. Qualifier suppression of entries already implied by community gates is a read/composer behavior concern, not a create-time configuration concern.\n"
          },
          "allow_qualifiers_on_anonymous_posts": {
            "type": "boolean",
            "nullable": true,
            "description": "Enables anonymous posts in the community to attach disclosed qualifiers from `allowed_disclosed_qualifiers`. Public v0 create may set this only when `allow_anonymous_identity = true`. If `false` or `null`, anonymous posts must not expose optional qualifiers.\n"
          },
          "root_post_min_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ],
            "nullable": true
          },
          "reply_min_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ],
            "nullable": true
          },
          "anonymous_posting_min_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ],
            "nullable": true
          },
          "root_post_quota_by_trust_tier": {
            "$ref": "./communities-core.yaml#/RootPostQuotaByTrustTier",
            "nullable": true
          },
          "reply_quota_by_trust_tier": {
            "$ref": "./communities-core.yaml#/ReplyQuotaByTrustTier",
            "nullable": true
          },
          "probation_window_days": {
            "type": "integer",
            "nullable": true
          },
          "link_post_policy": {
            "type": "string",
            "enum": [
              "allow",
              "require_established"
            ],
            "nullable": true
          },
          "default_age_gate_policy": {
            "type": "string",
            "enum": [
              "none",
              "18_plus"
            ],
            "default": "none",
            "description": "Community-wide default viewer age gate. Setting this to `18_plus` requires the acting creator or updating owner/admin to satisfy an accepted `age_over_18` proof requirement, such as `self` age verification.\n"
          },
          "agent_posting_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "review",
              "allow_with_disclosure",
              "allow"
            ],
            "nullable": true,
            "description": "Optional create-time user-agent posting policy. When omitted, reads must resolve the\nrestrictive default `disallow`.\n"
          },
          "agent_posting_scope": {
            "type": "string",
            "enum": [
              "replies_only",
              "top_level_and_replies"
            ],
            "nullable": true,
            "description": "Optional create-time scope for user-owned agent posting. When omitted in a context where\nuser-owned agents are enabled, reads should resolve `replies_only`.\n"
          },
          "agent_daily_post_cap": {
            "type": "integer",
            "nullable": true,
            "description": "Optional rolling 24-hour cap for user-agent top-level posts in this community.\n"
          },
          "agent_daily_reply_cap": {
            "type": "integer",
            "nullable": true,
            "description": "Optional rolling 24-hour cap for user-agent replies in this community.\n"
          },
          "agent_min_owner_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ],
            "nullable": true,
            "description": "Optional minimum trust tier the owning human must satisfy before their user-owned agent may post.\n"
          },
          "agent_owner_active_limit": {
            "type": "integer",
            "nullable": true,
            "description": "Optional community-local cap on active user-owned agents per human owner. Must not exceed\nthe platform-wide maximum.\n"
          },
          "human_verification_lane": {
            "type": "string",
            "enum": [
              "very",
              "self"
            ],
            "nullable": true,
            "description": "Primary public-v0 human-verification lane for this community. This is the UX-facing trust\nlane that tells users which verification path to complete first. `very` is the lighter\nbaseline `unique_human` lane. `self` is the higher-friction lane for communities that also\nneed richer identity-derived capabilities or stronger agent-native trust semantics. When\nomitted on create, the server may resolve a platform default lane. The server must reject\nor normalize lane selections that are inconsistent with the effective gate set. For\nexample, a community whose resolved gates require Self-only capabilities such as\n`nationality` or `age_over_18` must not resolve to `human_verification_lane = very`.\n"
          },
          "accepted_agent_ownership_providers": {
            "type": "array",
            "nullable": true,
            "description": "Optional stricter override for agent KYA acceptance. When omitted, reads should derive the\neffective accepted agent-ownership providers from `human_verification_lane` and the\ncommunity trust floor: any platform-approved KYA provider is acceptable so long as the\nbound human clears the required lane. The platform-approved provider set must come from an\nexplicit server-side policy source such as a config-backed allowlist or policy table; mere\npresence in an enum is not sufficient. Set this only when the community wants a narrower\nagent-auth posture, such as Self-only agent ownership.\n",
            "items": {
              "$ref": "./agents.yaml#/AgentOwnershipProvider"
            }
          },
          "namespace": {
            "allOf": [
              {
                "$ref": "./handles.yaml#/NamespaceAttachmentInput"
              }
            ],
            "nullable": true,
            "description": "Namespace attachment input for community creation. When provided, this must reference an accepted namespace-verification object via `namespace_verification_id`; the server must consume that accepted verification, not treat the field as a blind string. When omitted, the community is created without a namespace and can attach one later.\n"
          },
          "handle_policy": {
            "allOf": [
              {
                "$ref": "./handles.yaml#/HandlePolicyInput"
              }
            ],
            "description": "Public v0 new communities should normally start with the `standard` handle-policy template. This creates the namespace policy record at community creation time without implying that public community-local handle claims or namespace commerce are already enabled; those remain disabled until server-derived capability flags unlock them.\n"
          },
          "donation_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityDonationPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. Remains valid in the API for internal and future use.\n"
          },
          "content_authenticity_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityContentAuthenticityPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must enforce the restrictive default effective policy from the first post onward. Platform-minimum synthetic-likeness bans still override any submitted value.\n"
          },
          "source_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunitySourcePolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must enforce the restrictive default effective policy from the first post onward. This policy governs repost and fan-work handling rather than AI authenticity.\n"
          },
          "capture_edit_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityCaptureEditPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must enforce the effective default non-generative edit policy from the first post onward.\n"
          },
          "adult_content_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityAdultContentPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must enforce the effective default adult-content subcategory policy from the first post onward.\n"
          },
          "graphic_content_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityGraphicContentPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must enforce the effective default graphic-content subcategory policy from the first post onward.\n"
          },
          "motion_media_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityMotionMediaPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must resolve the effective default motion-media policy from the first post onward.\n"
          },
          "language_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityLanguagePolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must enforce the effective default language policy from the first post onward.\n"
          },
          "civility_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityCivilityPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must enforce the effective default civility policy from the first post onward.\n"
          },
          "provenance_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityProvenancePolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must enforce the effective default provenance policy from the first post onward.\n"
          },
          "promotion_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityPromotionPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must enforce the effective default promotion policy from the first post onward.\n"
          },
          "content_authenticity_detection_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityContentAuthenticityDetectionPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must use the platform-default authenticity-detection profile from the first post onward. Platform-required safety and age-gating analysis remain platform-managed and unaffected.\n"
          },
          "market_context_policy": {
            "allOf": [
              {
                "$ref": "./market-context.yaml#/CreateCommunityMarketContextPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must resolve the platform-default market-context policy from the first eligible post onward.\n"
          },
          "money_policy": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CreateCommunityMoneyPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. If omitted, the server must resolve the effective default community money policy. This attached policy defines purchase funding lanes and route constraints without turning the community object into a chain or route object.\n"
          },
          "community_bootstrap": {
            "$ref": "./communities-community.yaml#/CreateCommunityBootstrapInput",
            "nullable": true,
            "description": "Deferred from the public v0 create client. May be configured during post-create onboarding or through community settings. Remains valid in the API for internal and future use.\n"
          },
          "gate_rules": {
            "type": "array",
            "items": {
              "$ref": "./communities-core.yaml#/GateRuleInput"
            },
            "nullable": true,
            "description": "Public v0 create is limited to `membership`-scope gate rules only. Each `identity_proof`\nsubmitted gate rule must include explicit `proof_requirements`. `viewer`-scope gates and\n`posting`-scope gates are not supported in v0. The server should reject create requests\ncontaining gate rules that fall outside the public v0 scope.\nPublic v0 supports `sanctions_clear` through Human Passport-backed capability state. Self\nOFAC remains deferred until its verifier response polarity and fail-closed parser behavior\nare pinned by tests.\nPublic v0 self-serve creation supports a narrow token-holding lane for Ethereum mainnet\nERC-721 collection membership gates only. Other token-holding variants remain unsupported.\n"
          }
        }
      },
      "GateRuleInput": {
        "type": "object",
        "required": [
          "scope",
          "gate_family",
          "gate_type"
        ],
        "properties": {
          "scope": {
            "type": "string",
            "enum": [
              "membership",
              "viewer",
              "posting"
            ]
          },
          "gate_family": {
            "type": "string",
            "enum": [
              "token_holding",
              "identity_proof"
            ]
          },
          "gate_type": {
            "type": "string",
            "enum": [
              "unique_human",
              "age_over_18",
              "minimum_age",
              "nationality",
              "gender",
              "wallet_score",
              "erc721_holding",
              "erc721_inventory_match"
            ]
          },
          "proof_requirements": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "./communities-core.yaml#/ProofRequirement"
            }
          },
          "chain_namespace": {
            "type": "string",
            "nullable": true
          },
          "gate_config": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true,
            "description": "Provider-neutral rule config for the selected gate. For public-v0 gates, normalize on a\nsmall shared shape rather than arbitrary provider knobs:\n- `nationality`: `required_value` (single ISO code) or `excluded_values` (array of ISO codes)\n- `minimum_age`: `minimum_age` integer threshold from 18 to 125\n- `gender`: `required_value` for the Self document marker (`M` or `F`)\n- `wallet_score`: `minimum_score` (number)\n- `erc721_holding`: `contract_address` on Ethereum mainnet (`chain_namespace: eip155:1`)\n- `erc721_inventory_match`: `contract_address`, `inventory_provider`, `min_quantity`, and canonical `match`\n  for an allowlisted ERC-721 inventory provider. The public v0 Courtyard lane currently resolves\n  against Courtyard's Polygon inventory API (`chain_namespace: eip155:137`) after server-side\n  provider validation. Existing stored gates may still read legacy `asset_filter`, but new\n  authoring flows should write `match`.\nDeferred/admin-only gates may additionally use:\n- `sanctions_clear`: no extra config required\n"
          }
        }
      },
      "GateRule": {
        "type": "object",
        "required": [
          "gate_rule_id",
          "community_id",
          "scope",
          "gate_family",
          "gate_type",
          "status",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "gate_rule_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "scope": {
            "type": "string",
            "enum": [
              "membership",
              "viewer",
              "posting"
            ]
          },
          "gate_family": {
            "type": "string",
            "enum": [
              "token_holding",
              "identity_proof"
            ]
          },
          "gate_type": {
            "type": "string",
            "enum": [
              "unique_human",
              "age_over_18",
              "minimum_age",
              "nationality",
              "gender",
              "wallet_score",
              "erc721_holding",
              "erc721_inventory_match"
            ]
          },
          "proof_requirements": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "./communities-core.yaml#/ProofRequirement"
            }
          },
          "chain_namespace": {
            "type": "string",
            "nullable": true
          },
          "gate_config": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true,
            "description": "Stored provider-neutral rule config. For public-v0 gates, normalize on:\n- `nationality`: `required_value` or `excluded_values`\n- `minimum_age`: `minimum_age`\n- `gender`: `required_value` for the Self document marker\n- `wallet_score`: `minimum_score`\n- `erc721_holding`: `contract_address`\n- `erc721_inventory_match`: `contract_address`, `inventory_provider`, `min_quantity`, and canonical `match`\n  (`asset_filter` is legacy read compatibility)\nDeferred/admin-only gates may additionally use:\n- `sanctions_clear`: no extra config\n"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "disabled"
            ]
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "ProofRequirement": {
        "type": "object",
        "required": [
          "proof_type"
        ],
        "x-valid-providers-by-proof-type": {
          "unique_human": [
            "self",
            "very"
          ],
          "age_over_18": [
            "self"
          ],
          "minimum_age": [
            "self"
          ],
          "nationality": [
            "self"
          ],
          "gender": [
            "self"
          ],
          "wallet_score": [
            "passport"
          ]
        },
        "x-unvalidated-proof-types": [
          "biometric_liveness",
          "gov_id",
          "phone"
        ],
        "properties": {
          "proof_type": {
            "type": "string",
            "enum": [
              "unique_human",
              "biometric_liveness",
              "wallet_score",
              "gov_id",
              "age_over_18",
              "minimum_age",
              "nationality",
              "gender",
              "phone"
            ]
          },
          "accepted_providers": {
            "type": "array",
            "nullable": true,
            "description": "Optional provider allowlist for the selected `proof_type`.\nValid public-v0 combinations are:\n- `unique_human`: `self` or `very`\n- `age_over_18`: `self`\n- `minimum_age`: `self`\n- `nationality`: `self`\n- `gender`: `self` (document marker `M` / `F`)\n- `wallet_score`: `passport`\n- `sanctions_clear`: `passport`\nSelf OFAC-backed `sanctions_clear` is intentionally not public-v0 until launch config,\nbackend verification config, response polarity, and parser tests are pinned.\nOther modeled proof types such as `biometric_liveness`, `gov_id`, and `phone` remain\nintentionally unvalidated at the public-v0 provider-matrix layer until the product locks\ntheir accepted-provider rules.\n",
            "items": {
              "type": "string",
              "enum": [
                "self",
                "very",
                "passport"
              ]
            }
          },
          "accepted_mechanisms": {
            "type": "array",
            "nullable": true,
            "description": "Optional mechanism allowlist for provider-backed proofs. Public-v0 sanctions mechanisms are\n`passport_clean_hands` for Human Passport Clean Hands. `CleanHands` remains accepted as a\nlegacy Passport mechanism value.\n",
            "items": {
              "type": "string"
            }
          },
          "config": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true,
            "description": "Optional proof-level constraints. For public v0, identity-proof community gates should\nprefer provider-neutral semantics here or in `gate_config`:\n- `required_value` for `nationality` or the Self document marker `gender`\n- `excluded_values` for `nationality`\n- `minimum_score` for `wallet_score`\n"
          }
        }
      },
      "RootPostQuotaRule": {
        "type": "object",
        "required": [
          "window_hours",
          "max_root_posts",
          "max_song_posts",
          "max_video_posts"
        ],
        "properties": {
          "window_hours": {
            "type": "integer"
          },
          "max_root_posts": {
            "type": "integer"
          },
          "max_song_posts": {
            "type": "integer"
          },
          "max_video_posts": {
            "type": "integer"
          }
        }
      },
      "RootPostQuotaByTrustTier": {
        "type": "object",
        "properties": {
          "new": {
            "$ref": "./communities-core.yaml#/RootPostQuotaRule"
          },
          "established": {
            "$ref": "./communities-core.yaml#/RootPostQuotaRule"
          },
          "trusted": {
            "$ref": "./communities-core.yaml#/RootPostQuotaRule"
          },
          "high_trust": {
            "$ref": "./communities-core.yaml#/RootPostQuotaRule"
          }
        }
      },
      "ReplyQuotaRule": {
        "type": "object",
        "required": [
          "window_hours",
          "max_replies",
          "burst_window_minutes",
          "max_replies_per_burst"
        ],
        "properties": {
          "window_hours": {
            "type": "integer"
          },
          "max_replies": {
            "type": "integer"
          },
          "burst_window_minutes": {
            "type": "integer"
          },
          "max_replies_per_burst": {
            "type": "integer"
          }
        }
      },
      "ReplyQuotaByTrustTier": {
        "type": "object",
        "properties": {
          "new": {
            "$ref": "./communities-core.yaml#/ReplyQuotaRule"
          },
          "established": {
            "$ref": "./communities-core.yaml#/ReplyQuotaRule"
          },
          "trusted": {
            "$ref": "./communities-core.yaml#/ReplyQuotaRule"
          },
          "high_trust": {
            "$ref": "./communities-core.yaml#/ReplyQuotaRule"
          }
        }
      },
      "CreateCommunityRequest": {
        "oneOf": [
          {
            "$ref": "./communities-governance.yaml#/CreateCentralizedCommunityRequest"
          },
          {
            "$ref": "./communities-governance.yaml#/CreateMultisigCommunityRequest"
          },
          {
            "$ref": "./communities-governance.yaml#/CreateMajeurCommunityRequest"
          }
        ],
        "discriminator": {
          "propertyName": "governance_mode",
          "mapping": {
            "centralized": "#/components/schemas/CreateCentralizedCommunityRequest",
            "multisig": "#/components/schemas/CreateMultisigCommunityRequest",
            "majeur": "#/components/schemas/CreateMajeurCommunityRequest"
          }
        },
        "description": "Public v0 clients must submit only `CreateCentralizedCommunityRequest` (governance_mode = centralized). `CreateMultisigCommunityRequest` and `CreateMajeurCommunityRequest` remain valid in the API for internal, allowlisted, or feature-flagged use only. The public client must not submit them.\n\nFor namespace-backed public v0 create, when `namespace` is provided the server must resolve `namespace.namespace_verification_id` to the accepted `NamespaceVerification` resource, confirm it belongs to the requesting creator, and reject the create if the accepted verification is stale, disputed, expired, or no longer satisfies `club_attach_allowed`. When `namespace` is omitted, the community is created without a namespace and can attach one later.\n"
      },
      "CommunityCreateAcceptedResponse": {
        "type": "object",
        "required": [
          "community",
          "job"
        ],
        "properties": {
          "community": {
            "$ref": "./communities-core.yaml#/Community"
          },
          "job": {
            "$ref": "./jobs.yaml#/Job",
            "description": "The operational community-provisioning job returned by `POST /communities`.\n"
          }
        },
        "description": "Async acceptance response for community creation. Returns both the community row and\nits operational provisioning job so CLI and SDK clients can continue without secondary\nlookup.\n"
      },
      "UpdateCommunityRequest": {
        "type": "object",
        "properties": {
          "display_name": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "banner_ref": {
            "type": "string",
            "nullable": true
          },
          "membership_mode": {
            "type": "string",
            "enum": [
              "open",
              "request",
              "gated"
            ]
          },
          "allow_anonymous_identity": {
            "type": "boolean"
          },
          "anonymous_identity_scope": {
            "type": "string",
            "enum": [
              "community_stable",
              "thread_stable",
              "post_ephemeral"
            ],
            "nullable": true
          },
          "allowed_disclosed_qualifiers": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "allow_qualifiers_on_anonymous_posts": {
            "type": "boolean",
            "nullable": true,
            "description": "Enables anonymous posts in the club to attach disclosed qualifiers from `allowed_disclosed_qualifiers`. If `false` or `null`, anonymous posts must not expose optional qualifiers.\n"
          },
          "root_post_min_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ]
          },
          "reply_min_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ]
          },
          "anonymous_posting_min_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ]
          },
          "root_post_quota_by_trust_tier": {
            "$ref": "./communities-core.yaml#/RootPostQuotaByTrustTier"
          },
          "reply_quota_by_trust_tier": {
            "$ref": "./communities-core.yaml#/ReplyQuotaByTrustTier"
          },
          "probation_window_days": {
            "type": "integer",
            "nullable": true
          },
          "link_post_policy": {
            "type": "string",
            "enum": [
              "allow",
              "require_established"
            ]
          },
          "default_age_gate_policy": {
            "type": "string",
            "enum": [
              "none",
              "18_plus"
            ],
            "description": "Community-wide default viewer age gate. Updating this field from `none` to `18_plus` requires the acting owner/admin to satisfy an accepted `age_over_18` proof requirement, such as `self` age verification.\n"
          },
          "agent_posting_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "review",
              "allow_with_disclosure",
              "allow"
            ],
            "nullable": true
          },
          "agent_posting_scope": {
            "type": "string",
            "enum": [
              "replies_only",
              "top_level_and_replies"
            ],
            "nullable": true
          },
          "agent_daily_post_cap": {
            "type": "integer",
            "nullable": true,
            "description": "Rolling 24-hour cap for user-agent top-level posts. Null clears the explicit setting.\n"
          },
          "agent_daily_reply_cap": {
            "type": "integer",
            "nullable": true,
            "description": "Rolling 24-hour cap for user-agent replies. Null clears the explicit setting.\n"
          },
          "agent_min_owner_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ],
            "nullable": true
          },
          "agent_owner_active_limit": {
            "type": "integer",
            "nullable": true
          },
          "human_verification_lane": {
            "$ref": "./communities-core.yaml#/HumanVerificationLane",
            "nullable": true,
            "description": "Optional update-time override for the community's primary human-verification lane. Null\nclears the explicit override so the server can re-derive the effective lane from the\ncurrent gate set or platform default.\n"
          },
          "accepted_agent_ownership_providers": {
            "type": "array",
            "nullable": true,
            "description": "Optional update-time stricter override for accepted agent-ownership providers. Null clears\nthe explicit override so reads can return the server-derived effective provider set.\n",
            "items": {
              "$ref": "./agents.yaml#/AgentOwnershipProvider"
            }
          }
        }
      },
      "CommunityFundingRouteStatusPolicy": {
        "type": "string",
        "enum": [
          "fail",
          "fallback_display",
          "queue"
        ]
      },
      "CommunityMoneyAssetRef": {
        "type": "object",
        "description": "Executable funding asset reference for community purchase funding. This may be narrower than the community's user-facing funding preference. For example, `funding_preference = BTC` may still only permit `cBTC` on Citrea as an executable purchase-funding asset.\n",
        "required": [
          "asset_symbol"
        ],
        "additionalProperties": false,
        "properties": {
          "asset_symbol": {
            "type": "string"
          },
          "chain_namespace": {
            "type": "string",
            "nullable": true
          },
          "chain_id": {
            "type": "integer",
            "nullable": true
          },
          "display_name": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CommunityMoneyChainRef": {
        "type": "object",
        "description": "Source-chain reference for a community funding lane. This is an attached commerce-policy concept, not a mutation of the community's core identity.\n",
        "required": [
          "chain_namespace"
        ],
        "additionalProperties": false,
        "properties": {
          "chain_namespace": {
            "type": "string"
          },
          "chain_id": {
            "type": "integer",
            "nullable": true
          },
          "display_name": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CreateCommunityMoneyPolicyInput": {
        "type": "object",
        "description": "Optional community funding policy supplied at creation time. When omitted, the server must resolve the platform-default community money policy for the community. This policy defines allowed funding lanes for purchases and must not be interpreted as the community's execution or unlock chain.\n",
        "required": [
          "funding_preference",
          "accepted_funding_assets",
          "accepted_source_chains",
          "destination_settlement_chain",
          "destination_settlement_token",
          "max_slippage_bps",
          "quote_ttl_seconds",
          "route_required",
          "route_status_policy",
          "route_hop_tolerance"
        ],
        "additionalProperties": false,
        "properties": {
          "funding_preference": {
            "type": "string",
            "description": "User-facing funding identity for the community such as `BTC`, `ETH`, `SOL`, or `TEMPO`. This may be broader than the executable funding asset list.\n"
          },
          "accepted_funding_assets": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityMoneyAssetRef"
            }
          },
          "accepted_source_chains": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
            }
          },
          "approved_route_providers": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true,
            "description": "External route venues Pirate is willing to support for this community. When `route_required = true`, the server should require this list to be non-empty after validation, even if clients omit it on create.\n"
          },
          "destination_settlement_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
          },
          "destination_settlement_token": {
            "type": "string",
            "description": "Destination settlement token required by the purchase execution path, such as `WIP` on Story.\n"
          },
          "treasury_denomination": {
            "type": "string",
            "nullable": true,
            "description": "Treasury denomination preference for reporting and later treasury policy. This does not imply that settlement proceeds are automatically converted into that denomination.\n"
          },
          "max_slippage_bps": {
            "type": "integer",
            "minimum": 0
          },
          "quote_ttl_seconds": {
            "type": "integer",
            "minimum": 1
          },
          "route_required": {
            "type": "boolean"
          },
          "route_status_policy": {
            "$ref": "./communities-community.yaml#/CommunityFundingRouteStatusPolicy"
          },
          "route_hop_tolerance": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "UpdateCommunityMoneyPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community funding policy. Changes apply prospectively to future quotes and purchases. Existing purchases remain pinned to the quote and settlement snapshots used at execution time.\n",
        "required": [
          "funding_preference",
          "accepted_funding_assets",
          "accepted_source_chains",
          "destination_settlement_chain",
          "destination_settlement_token",
          "max_slippage_bps",
          "quote_ttl_seconds",
          "route_required",
          "route_status_policy",
          "route_hop_tolerance"
        ],
        "additionalProperties": false,
        "properties": {
          "funding_preference": {
            "type": "string"
          },
          "accepted_funding_assets": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityMoneyAssetRef"
            }
          },
          "accepted_source_chains": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
            }
          },
          "approved_route_providers": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "destination_settlement_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
          },
          "destination_settlement_token": {
            "type": "string"
          },
          "treasury_denomination": {
            "type": "string",
            "nullable": true
          },
          "max_slippage_bps": {
            "type": "integer",
            "minimum": 0
          },
          "quote_ttl_seconds": {
            "type": "integer",
            "minimum": 1
          },
          "route_required": {
            "type": "boolean"
          },
          "route_status_policy": {
            "$ref": "./communities-community.yaml#/CommunityFundingRouteStatusPolicy"
          },
          "route_hop_tolerance": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "CommunityMoneyPolicy": {
        "type": "object",
        "description": "Resolved community funding policy for commerce. This policy controls allowed buyer funding lanes and route constraints. It does not redefine the community object as a chain object, and it does not imply that the funding asset itself performs settlement or locked-asset unlocks. When no explicit money policy has been configured, the server must still return the effective default policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "funding_preference",
          "accepted_funding_assets",
          "accepted_source_chains",
          "destination_settlement_chain",
          "destination_settlement_token",
          "max_slippage_bps",
          "quote_ttl_seconds",
          "route_required",
          "route_status_policy",
          "route_hop_tolerance",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "funding_preference": {
            "type": "string"
          },
          "accepted_funding_assets": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityMoneyAssetRef"
            }
          },
          "accepted_source_chains": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
            }
          },
          "approved_route_providers": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "destination_settlement_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
          },
          "destination_settlement_token": {
            "type": "string"
          },
          "treasury_denomination": {
            "type": "string",
            "nullable": true
          },
          "max_slippage_bps": {
            "type": "integer",
            "minimum": 0
          },
          "quote_ttl_seconds": {
            "type": "integer",
            "minimum": 1
          },
          "route_required": {
            "type": "boolean"
          },
          "route_status_policy": {
            "$ref": "./communities-community.yaml#/CommunityFundingRouteStatusPolicy"
          },
          "route_hop_tolerance": {
            "type": "integer",
            "minimum": 0
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityPurchaseFundingMode": {
        "type": "string",
        "enum": [
          "direct",
          "routed"
        ]
      },
      "CommunityPurchaseSettlementMode": {
        "type": "string",
        "enum": [
          "delivery_only_story_settlement",
          "royalty_native_story_payment"
        ]
      },
      "CommunityPurchaseQuotePreflightRequest": {
        "type": "object",
        "description": "Funding-lane preflight input for a future community purchase quote. This validates the proposed buyer funding lane against the community's effective money policy and returns a quote snapshot for the settlement lane Pirate would require. This does not price a listing, reserve liquidity, or execute settlement. Route estimate fields are client-estimated in this implementation slice and must not be interpreted as server-verified route telemetry.\n",
        "required": [
          "client_estimated_slippage_bps",
          "client_estimated_hop_count"
        ],
        "additionalProperties": false,
        "properties": {
          "listing_id": {
            "type": "string",
            "nullable": true
          },
          "funding_asset": {
            "$ref": "./communities-community.yaml#/CommunityMoneyAssetRef",
            "nullable": true
          },
          "source_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef",
            "nullable": true
          },
          "route_provider": {
            "type": "string",
            "nullable": true
          },
          "client_estimated_slippage_bps": {
            "type": "integer",
            "minimum": 0
          },
          "client_estimated_hop_count": {
            "type": "integer",
            "minimum": 0
          },
          "client_route_valid_for_seconds": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          }
        }
      },
      "CommunityPurchaseQuotePreflight": {
        "type": "object",
        "description": "Effective community purchase quote preflight snapshot. A successful response means the requested funding lane satisfies the community's current money policy. The response surfaces the required settlement lane and policy-derived quote expiry, but does not include listing pricing or a reserved route.\n",
        "required": [
          "community_id",
          "eligible",
          "funding_mode",
          "policy_origin",
          "funding_preference",
          "destination_settlement_chain",
          "destination_settlement_token",
          "max_slippage_bps",
          "quote_ttl_seconds",
          "route_required",
          "route_status_policy",
          "route_hop_tolerance",
          "quoted_at",
          "expires_at"
        ],
        "additionalProperties": false,
        "properties": {
          "community_id": {
            "type": "string"
          },
          "eligible": {
            "type": "boolean"
          },
          "funding_mode": {
            "$ref": "./communities-community.yaml#/CommunityPurchaseFundingMode"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "funding_preference": {
            "type": "string"
          },
          "funding_asset": {
            "$ref": "./communities-community.yaml#/CommunityMoneyAssetRef",
            "nullable": true
          },
          "source_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef",
            "nullable": true
          },
          "route_provider": {
            "type": "string",
            "nullable": true
          },
          "destination_settlement_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
          },
          "destination_settlement_token": {
            "type": "string"
          },
          "treasury_denomination": {
            "type": "string",
            "nullable": true
          },
          "max_slippage_bps": {
            "type": "integer",
            "minimum": 0
          },
          "quote_ttl_seconds": {
            "type": "integer",
            "minimum": 1
          },
          "route_required": {
            "type": "boolean"
          },
          "route_status_policy": {
            "$ref": "./communities-community.yaml#/CommunityFundingRouteStatusPolicy"
          },
          "route_hop_tolerance": {
            "type": "integer",
            "minimum": 0
          },
          "base_price_usd": {
            "type": "number",
            "nullable": true
          },
          "viewer_price_usd": {
            "type": "number",
            "nullable": true
          },
          "best_verified_price_usd": {
            "type": "number",
            "nullable": true
          },
          "max_self_discount_percent": {
            "type": "number",
            "nullable": true
          },
          "verification_required_provider": {
            "$ref": "./communities-community.yaml#/CommunityPricingVerificationProvider",
            "nullable": true
          },
          "quoted_at": {
            "type": "string",
            "format": "date-time"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityPurchaseQuoteRequest": {
        "type": "object",
        "description": "Request a short-lived priced purchase quote for a persisted community listing. The server must load the listing by `listing_id`, verify it belongs to the community and is currently sellable, and derive the quote from the authoritative stored listing price rather than trusting a client-supplied amount. Route estimate fields are client-estimated in this implementation slice and must not be interpreted as server-verified route telemetry.\n",
        "required": [
          "listing_id",
          "client_estimated_slippage_bps",
          "client_estimated_hop_count"
        ],
        "additionalProperties": false,
        "properties": {
          "listing_id": {
            "type": "string"
          },
          "funding_asset": {
            "$ref": "./communities-community.yaml#/CommunityMoneyAssetRef",
            "nullable": true
          },
          "source_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef",
            "nullable": true
          },
          "route_provider": {
            "type": "string",
            "nullable": true
          },
          "client_estimated_slippage_bps": {
            "type": "integer",
            "minimum": 0
          },
          "client_estimated_hop_count": {
            "type": "integer",
            "minimum": 0
          },
          "client_route_valid_for_seconds": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          }
        }
      },
      "CommunityPurchaseQuote": {
        "type": "object",
        "description": "Short-lived purchase quote snapshot for a community commerce object. This response is priced in USD using the persisted authored listing price and the community's current money policy. It is a quote record, not a completed purchase or settlement. In this implementation slice, route-policy compliance is checked server-side, but live bridge/swap liquidity is not yet verified.\n",
        "required": [
          "quote_id",
          "community_id",
          "listing_id",
          "buyer_user_id",
          "base_price_usd",
          "final_price_usd",
          "settlement_mode",
          "allocation_snapshot",
          "funding_mode",
          "route_policy_compliant",
          "policy_origin",
          "destination_settlement_chain",
          "destination_settlement_token",
          "quote_ttl_seconds",
          "route_required",
          "route_status_policy",
          "route_hop_tolerance",
          "quoted_at",
          "expires_at"
        ],
        "additionalProperties": false,
        "properties": {
          "quote_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "listing_id": {
            "type": "string"
          },
          "buyer_user_id": {
            "type": "string"
          },
          "asset_id": {
            "type": "string",
            "nullable": true
          },
          "live_room_id": {
            "type": "string",
            "nullable": true
          },
          "base_price_usd": {
            "type": "number",
            "minimum": 0
          },
          "pricing_tier": {
            "type": "string",
            "nullable": true
          },
          "final_price_usd": {
            "type": "number",
            "minimum": 0
          },
          "settlement_mode": {
            "$ref": "./communities-community.yaml#/CommunityPurchaseSettlementMode"
          },
          "allocation_snapshot": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunitySaleAllocationSnapshot"
            }
          },
          "funding_mode": {
            "$ref": "./communities-community.yaml#/CommunityPurchaseFundingMode"
          },
          "funding_asset": {
            "$ref": "./communities-community.yaml#/CommunityMoneyAssetRef",
            "nullable": true
          },
          "source_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef",
            "nullable": true
          },
          "route_provider": {
            "type": "string",
            "nullable": true
          },
          "route_policy_compliant": {
            "type": "boolean",
            "description": "`true` means the requested funding lane passed community money-policy validation.\n"
          },
          "route_live_available": {
            "type": "boolean",
            "nullable": true,
            "description": "Live route availability from an external venue. This implementation slice does not yet verify live liquidity or bridge uptime, so this field currently remains `null`.\n"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "destination_settlement_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
          },
          "destination_settlement_token": {
            "type": "string"
          },
          "destination_settlement_amount_atomic": {
            "type": "string",
            "nullable": true,
            "description": "Atomic amount of destination settlement token Pirate will pay into the Story royalty path after buyer funding and quote-time allocation are verified."
          },
          "destination_settlement_decimals": {
            "type": "integer",
            "nullable": true,
            "minimum": 0
          },
          "funding_destination_address": {
            "type": "string",
            "nullable": true,
            "description": "Checkout operator address that must receive the buyer-facing funding asset for this quote."
          },
          "treasury_denomination": {
            "type": "string",
            "nullable": true
          },
          "quote_ttl_seconds": {
            "type": "integer",
            "minimum": 1
          },
          "route_required": {
            "type": "boolean"
          },
          "route_status_policy": {
            "$ref": "./communities-community.yaml#/CommunityFundingRouteStatusPolicy"
          },
          "route_hop_tolerance": {
            "type": "integer",
            "minimum": 0
          },
          "verification_snapshot_ref": {
            "type": "string",
            "nullable": true
          },
          "pricing_policy_version": {
            "type": "string",
            "nullable": true
          },
          "quoted_at": {
            "type": "string",
            "format": "date-time"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCentralizedCommunityRequest": {
        "allOf": [
          {
            "$ref": "./communities-core.yaml#/CreateCommunityRequestBase"
          },
          {
            "type": "object",
            "required": [
              "governance_mode"
            ],
            "properties": {
              "governance_mode": {
                "type": "string",
                "enum": [
                  "centralized"
                ],
                "default": "centralized"
              }
            }
          }
        ],
        "description": "The only create variant accepted from the public v0 client. All public community creation submits this request type.\n"
      },
      "CreateMultisigCommunityRequest": {
        "allOf": [
          {
            "$ref": "./communities-core.yaml#/CreateCommunityRequestBase"
          },
          {
            "type": "object",
            "required": [
              "governance_mode",
              "governance_backend"
            ],
            "properties": {
              "governance_mode": {
                "type": "string",
                "enum": [
                  "multisig"
                ]
              },
              "governance_backend": {
                "$ref": "./communities-governance.yaml#/MultisigGovernanceAttachmentInput"
              }
            }
          }
        ],
        "description": "Internal, allowlisted, or feature-flagged only. The public v0 client must not submit this request type. Public multisig attachment happens after creation via POST /communities/{community_id}/attach-governance.\n"
      },
      "CreateMajeurCommunityRequest": {
        "allOf": [
          {
            "$ref": "./communities-core.yaml#/CreateCommunityRequestBase"
          },
          {
            "type": "object",
            "required": [
              "governance_mode",
              "governance_backend"
            ],
            "properties": {
              "governance_mode": {
                "type": "string",
                "enum": [
                  "majeur"
                ]
              },
              "governance_backend": {
                "$ref": "./communities-governance.yaml#/MajeurGovernanceCreateInput"
              }
            }
          }
        ],
        "description": "Internal, allowlisted, or feature-flagged only. The public v0 client must not submit this request type. Public majeur attachment happens after creation via POST /communities/{community_id}/attach-governance.\n"
      },
      "AttachGovernanceRequest": {
        "oneOf": [
          {
            "$ref": "./communities-governance.yaml#/AttachMultisigGovernanceRequest"
          },
          {
            "$ref": "./communities-governance.yaml#/AttachMajeurGovernanceRequest"
          }
        ],
        "discriminator": {
          "propertyName": "governance_mode",
          "mapping": {
            "multisig": "#/components/schemas/AttachMultisigGovernanceRequest",
            "majeur": "#/components/schemas/AttachMajeurGovernanceRequest"
          }
        }
      },
      "AttachMultisigGovernanceRequest": {
        "type": "object",
        "required": [
          "governance_mode",
          "governance_backend"
        ],
        "properties": {
          "governance_mode": {
            "type": "string",
            "enum": [
              "multisig"
            ]
          },
          "governance_backend": {
            "$ref": "./communities-governance.yaml#/MultisigGovernanceAttachmentInput"
          }
        }
      },
      "AttachMajeurGovernanceRequest": {
        "type": "object",
        "required": [
          "governance_mode",
          "governance_backend"
        ],
        "properties": {
          "governance_mode": {
            "type": "string",
            "enum": [
              "majeur"
            ]
          },
          "governance_backend": {
            "$ref": "./communities-governance.yaml#/MajeurGovernanceAttachInput"
          }
        }
      },
      "GovernanceAction": {
        "type": "object",
        "required": [
          "governance_action_id",
          "community_id",
          "action_kind",
          "governance_mode",
          "payload_hash",
          "status",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "governance_action_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "action_kind": {
            "type": "string",
            "enum": [
              "attach_governance",
              "replace_governance"
            ]
          },
          "requested_by_user_id": {
            "type": "string",
            "nullable": true
          },
          "governance_mode": {
            "type": "string",
            "enum": [
              "multisig",
              "majeur"
            ]
          },
          "chain_id": {
            "type": "integer",
            "nullable": true
          },
          "target_address": {
            "type": "string",
            "nullable": true
          },
          "payload_hash": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "awaiting_external_approval",
              "executed",
              "rejected",
              "expired"
            ]
          },
          "external_state": {
            "type": "string",
            "nullable": true
          },
          "execution_tx_hash": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "UpdateCommunityGovernanceRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "governance_backend"
        ],
        "properties": {
          "governance_backend": {
            "$ref": "./communities-governance.yaml#/CommunityGovernanceBackend"
          }
        }
      },
      "CommunityGovernanceMutationResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_id",
          "governance_backend"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "governance_backend": {
            "$ref": "./communities-governance.yaml#/CommunityGovernanceBackend"
          }
        }
      },
      "GovernanceVerificationState": {
        "type": "string",
        "enum": [
          "not_required",
          "pending",
          "verified",
          "broken"
        ]
      },
      "CommunityGovernanceBackend": {
        "oneOf": [
          {
            "$ref": "./communities-governance.yaml#/CentralizedGovernanceBackend"
          },
          {
            "$ref": "./communities-governance.yaml#/MultisigGovernanceBackend"
          },
          {
            "$ref": "./communities-governance.yaml#/MajeurGovernanceBackend"
          }
        ],
        "discriminator": {
          "propertyName": "governance_mode",
          "mapping": {
            "centralized": "#/components/schemas/CentralizedGovernanceBackend",
            "multisig": "#/components/schemas/MultisigGovernanceBackend",
            "majeur": "#/components/schemas/MajeurGovernanceBackend"
          }
        }
      },
      "CentralizedGovernanceBackend": {
        "type": "object",
        "required": [
          "governance_mode",
          "governance_verification_state"
        ],
        "properties": {
          "governance_mode": {
            "type": "string",
            "enum": [
              "centralized"
            ]
          },
          "governance_verification_state": {
            "$ref": "./communities-governance.yaml#/GovernanceVerificationState"
          },
          "governance_display_label": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "MultisigGovernanceAttachmentInput": {
        "type": "object",
        "required": [
          "chain_id",
          "contract_address",
          "attachment_proof"
        ],
        "properties": {
          "chain_id": {
            "type": "integer"
          },
          "contract_address": {
            "type": "string"
          },
          "treasury_address": {
            "type": "string",
            "nullable": true
          },
          "attachment_proof": {
            "$ref": "./communities-governance.yaml#/MultisigAttachmentProofInput"
          }
        }
      },
      "MultisigAttachmentProofInput": {
        "type": "object",
        "required": [
          "proof_kind",
          "challenge",
          "signature"
        ],
        "properties": {
          "proof_kind": {
            "type": "string",
            "enum": [
              "eip1271"
            ]
          },
          "challenge": {
            "type": "string"
          },
          "signature": {
            "type": "string"
          }
        }
      },
      "MultisigGovernanceBackend": {
        "type": "object",
        "required": [
          "governance_mode",
          "governance_chain_id",
          "governance_contract_address",
          "governance_verification_state",
          "governance_metadata"
        ],
        "properties": {
          "governance_mode": {
            "type": "string",
            "enum": [
              "multisig"
            ]
          },
          "governance_chain_id": {
            "type": "integer"
          },
          "governance_contract_address": {
            "type": "string"
          },
          "governance_treasury_address": {
            "type": "string",
            "nullable": true
          },
          "governance_verification_state": {
            "$ref": "./communities-governance.yaml#/GovernanceVerificationState"
          },
          "governance_display_label": {
            "type": "string",
            "nullable": true
          },
          "governance_attached_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "governance_last_verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "governance_metadata": {
            "$ref": "./communities-governance.yaml#/MultisigGovernanceMetadata"
          }
        }
      },
      "MultisigGovernanceMetadata": {
        "type": "object",
        "required": [
          "owners",
          "threshold",
          "is_safe_compatible"
        ],
        "properties": {
          "owners": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "threshold": {
            "type": "integer"
          },
          "is_safe_compatible": {
            "type": "boolean"
          },
          "version_label": {
            "type": "string",
            "nullable": true
          },
          "master_copy_address": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "MajeurGovernanceCreateInput": {
        "type": "object",
        "required": [
          "chain_id",
          "summon"
        ],
        "properties": {
          "chain_id": {
            "type": "integer"
          },
          "summon": {
            "$ref": "./communities-governance.yaml#/MajeurSafeSummonInput"
          }
        }
      },
      "MajeurGovernanceAttachInput": {
        "type": "object",
        "required": [
          "chain_id",
          "dao_address"
        ],
        "properties": {
          "chain_id": {
            "type": "integer"
          },
          "dao_address": {
            "type": "string"
          },
          "deployment_tx_hash": {
            "type": "string",
            "nullable": true
          },
          "shares_address": {
            "type": "string",
            "nullable": true
          },
          "loot_address": {
            "type": "string",
            "nullable": true
          },
          "badges_address": {
            "type": "string",
            "nullable": true
          },
          "renderer_address": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "MajeurSafeSummonInput": {
        "type": "object",
        "required": [
          "org_name",
          "org_symbol",
          "ragequittable",
          "init_holders",
          "init_shares",
          "config"
        ],
        "properties": {
          "preset": {
            "type": "string",
            "enum": [
              "founder",
              "standard",
              "fast",
              "custom"
            ],
            "nullable": true
          },
          "org_name": {
            "type": "string"
          },
          "org_symbol": {
            "type": "string"
          },
          "org_uri": {
            "type": "string",
            "nullable": true
          },
          "quorum_bps": {
            "type": "integer",
            "nullable": true
          },
          "ragequittable": {
            "type": "boolean"
          },
          "renderer": {
            "type": "string",
            "nullable": true
          },
          "init_holders": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "init_shares": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "init_loot": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "config": {
            "$ref": "./communities-governance.yaml#/MajeurSafeConfigInput"
          }
        }
      },
      "MajeurSafeConfigInput": {
        "type": "object",
        "required": [
          "proposal_threshold",
          "proposal_ttl_seconds"
        ],
        "properties": {
          "proposal_threshold": {
            "type": "string"
          },
          "proposal_ttl_seconds": {
            "type": "integer"
          },
          "timelock_delay_seconds": {
            "type": "integer",
            "nullable": true
          },
          "quorum_absolute": {
            "type": "string",
            "nullable": true
          },
          "min_yes_votes_absolute": {
            "type": "string",
            "nullable": true
          },
          "lock_shares": {
            "type": "boolean",
            "default": false
          },
          "lock_loot": {
            "type": "boolean",
            "default": false
          },
          "rollback_guardian": {
            "type": "string",
            "nullable": true
          },
          "rollback_singleton": {
            "type": "string",
            "nullable": true
          },
          "rollback_expiry": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "MajeurGovernanceBackend": {
        "type": "object",
        "required": [
          "governance_mode",
          "governance_chain_id",
          "governance_contract_address",
          "governance_verification_state",
          "governance_metadata"
        ],
        "properties": {
          "governance_mode": {
            "type": "string",
            "enum": [
              "majeur"
            ]
          },
          "governance_chain_id": {
            "type": "integer"
          },
          "governance_contract_address": {
            "type": "string"
          },
          "governance_treasury_address": {
            "type": "string",
            "nullable": true
          },
          "governance_verification_state": {
            "$ref": "./communities-governance.yaml#/GovernanceVerificationState"
          },
          "governance_display_label": {
            "type": "string",
            "nullable": true
          },
          "governance_attached_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "governance_last_verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "governance_metadata": {
            "$ref": "./communities-governance.yaml#/MajeurGovernanceMetadata"
          }
        }
      },
      "MajeurGovernanceMetadata": {
        "type": "object",
        "required": [
          "shares_address",
          "loot_address",
          "badges_address",
          "ragequittable",
          "proposal_threshold",
          "proposal_ttl_seconds",
          "shares_locked",
          "loot_locked",
          "config_version"
        ],
        "properties": {
          "shares_address": {
            "type": "string"
          },
          "loot_address": {
            "type": "string"
          },
          "badges_address": {
            "type": "string"
          },
          "renderer_address": {
            "type": "string",
            "nullable": true
          },
          "ragequittable": {
            "type": "boolean"
          },
          "proposal_threshold": {
            "type": "string"
          },
          "proposal_ttl_seconds": {
            "type": "integer"
          },
          "timelock_delay_seconds": {
            "type": "integer",
            "nullable": true
          },
          "quorum_bps": {
            "type": "integer",
            "nullable": true
          },
          "quorum_absolute": {
            "type": "string",
            "nullable": true
          },
          "min_yes_votes_absolute": {
            "type": "string",
            "nullable": true
          },
          "shares_locked": {
            "type": "boolean"
          },
          "loot_locked": {
            "type": "boolean"
          },
          "auto_futarchy_param": {
            "type": "string",
            "nullable": true
          },
          "auto_futarchy_cap": {
            "type": "string",
            "nullable": true
          },
          "futarchy_reward_token": {
            "type": "string",
            "nullable": true
          },
          "config_version": {
            "type": "integer"
          }
        }
      },
      "NamespaceAttachmentInput": {
        "type": "object",
        "required": [
          "namespace_verification_id"
        ],
        "properties": {
          "namespace_verification_id": {
            "type": "string",
            "description": "Opaque server-issued identifier for the previously accepted namespace verification session. The server resolves this to the underlying root-control evidence and assertions at create time. Creation must be rejected if the referenced verification is stale, disputed, or does not satisfy `club_attach_allowed` for the relevant protocol family. This field is required for public v0 create. Label and route fields below are derived from the verification session and are used for display and routing, not as proof of root control.\n"
          },
          "display_label": {
            "type": "string",
            "description": "Optional derived display label for the verified namespace root. Clients may omit this on create and let the server derive it from `namespace_verification_id`. If submitted, it must match the verified namespace session.\n"
          },
          "normalized_label": {
            "type": "string",
            "description": "Optional derived normalized root label. Clients may omit this on create and let the server derive it from `namespace_verification_id`. If submitted, it must match the verified namespace session.\n"
          },
          "resolver_label": {
            "type": "string",
            "nullable": true,
            "description": "Optional derived resolver-facing label for routing or downstream namespace operations. Clients may omit this on create and let the server derive it from `namespace_verification_id`.\n"
          },
          "route_family": {
            "type": "string",
            "nullable": true,
            "description": "Optional derived route family such as bare-label or `@`-style routing. Clients may omit this on create and let the server derive it from `namespace_verification_id`. If submitted, it must match the verified namespace session.\n"
          }
        }
      },
      "HandlePolicyInput": {
        "type": "object",
        "required": [
          "policy_template"
        ],
        "properties": {
          "policy_template": {
            "type": "string",
            "enum": [
              "standard",
              "premium",
              "membership_gated",
              "custom"
            ],
            "description": "Namespace handle-policy template. This describes how community-local handles should behave once claims are enabled. Public v0 new communities should normally start with `standard`, while claim and sale availability remain disabled until server-derived capability flags enable them.\n"
          },
          "pricing_model": {
            "type": "string",
            "enum": [
              "free",
              "flat_by_length",
              "custom_curve",
              "gated_then_flat"
            ],
            "nullable": true,
            "description": "Optional pricing model for commerce-enabled templates. This does not by itself enable public claims or sales; launch availability is controlled separately by server-derived capability flags.\n"
          },
          "membership_required_for_claim": {
            "type": "boolean",
            "default": true
          }
        }
      },
      "Community": {
        "type": "object",
        "required": [
          "community_id",
          "display_name",
          "status",
          "provisioning_state",
          "membership_mode",
          "allow_anonymous_identity",
          "human_verification_lane",
          "human_verification_lane_origin",
          "agent_posting_policy",
          "agent_posting_scope",
          "accepted_agent_ownership_providers_origin",
          "accepted_agent_ownership_providers",
          "governance_mode",
          "donation_policy_mode",
          "donation_partner_status",
          "money_policy",
          "content_authenticity_policy",
          "content_authenticity_detection_policy",
          "market_context_policy",
          "source_policy",
          "capture_edit_policy",
          "adult_content_policy",
          "graphic_content_policy",
          "motion_media_policy",
          "language_policy",
          "civility_policy",
          "provenance_policy",
          "promotion_policy",
          "created_by_user_id",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "banner_ref": {
            "type": "string",
            "nullable": true
          },
          "namespace_verification_id": {
            "type": "string",
            "nullable": true,
            "description": "Attached accepted namespace-verification resource when the community is namespace-backed.\n"
          },
          "route_slug": {
            "type": "string",
            "nullable": true
          },
          "pending_namespace_verification_session_id": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "active",
              "frozen",
              "archived",
              "deleted"
            ]
          },
          "provisioning_state": {
            "type": "string",
            "enum": [
              "requested",
              "provisioning",
              "active",
              "rotation_required",
              "error"
            ],
            "description": "Community infrastructure lifecycle state. This is distinct from domain `status`.\nA community may be domain-active while infrastructure provisioning is still in progress.\n"
          },
          "artist_identity_id": {
            "type": "string",
            "nullable": true
          },
          "community_agent_user_id": {
            "type": "string",
            "nullable": true,
            "description": "App-level system actor for platform-managed community content such as daily questions. In v0, this actor is exempt from ordinary member trust-tier minima and posting quotas when publishing system-tagged content.\n"
          },
          "membership_mode": {
            "type": "string",
            "enum": [
              "open",
              "request",
              "gated"
            ]
          },
          "allow_anonymous_identity": {
            "type": "boolean"
          },
          "anonymous_identity_scope": {
            "type": "string",
            "enum": [
              "community_stable",
              "thread_stable",
              "post_ephemeral"
            ],
            "nullable": true
          },
          "human_verification_lane": {
            "$ref": "./communities-core.yaml#/HumanVerificationLane",
            "description": "Resolved effective public-v0 human-verification lane for this community.\n"
          },
          "human_verification_lane_origin": {
            "$ref": "./communities-core.yaml#/CommunityAgentResolutionOrigin",
            "description": "Whether `human_verification_lane` came from an explicit community override or was derived\nfrom the effective gate set or platform default.\n"
          },
          "allowed_disclosed_qualifiers": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "allow_qualifiers_on_anonymous_posts": {
            "type": "boolean",
            "nullable": true,
            "description": "Whether anonymous posts in the community may attach disclosed qualifiers from `allowed_disclosed_qualifiers`.\n"
          },
          "root_post_min_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ],
            "nullable": true
          },
          "reply_min_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ],
            "nullable": true
          },
          "anonymous_posting_min_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ],
            "nullable": true
          },
          "root_post_quota_by_trust_tier": {
            "$ref": "./communities-core.yaml#/RootPostQuotaByTrustTier",
            "nullable": true
          },
          "reply_quota_by_trust_tier": {
            "$ref": "./communities-core.yaml#/ReplyQuotaByTrustTier",
            "nullable": true
          },
          "probation_window_days": {
            "type": "integer",
            "nullable": true
          },
          "link_post_policy": {
            "type": "string",
            "enum": [
              "allow",
              "require_established"
            ],
            "nullable": true
          },
          "default_age_gate_policy": {
            "type": "string",
            "enum": [
              "none",
              "18_plus"
            ],
            "description": "Community-wide default viewer age gate.\n"
          },
          "agent_posting_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "review",
              "allow_with_disclosure",
              "allow"
            ],
            "description": "Resolved effective user-agent posting policy for this community.\n"
          },
          "agent_posting_scope": {
            "type": "string",
            "enum": [
              "replies_only",
              "top_level_and_replies"
            ],
            "description": "Resolved effective user-agent posting scope for this community.\n"
          },
          "agent_daily_post_cap": {
            "type": "integer",
            "nullable": true,
            "description": "Effective rolling 24-hour cap for user-agent top-level posts.\n"
          },
          "agent_daily_reply_cap": {
            "type": "integer",
            "nullable": true,
            "description": "Effective rolling 24-hour cap for user-agent replies.\n"
          },
          "agent_min_owner_trust_tier": {
            "type": "string",
            "enum": [
              "new",
              "established",
              "trusted",
              "high_trust"
            ],
            "nullable": true,
            "description": "Effective minimum trust tier the owning human must satisfy before their user-owned agent may post.\n"
          },
          "agent_owner_active_limit": {
            "type": "integer",
            "nullable": true,
            "description": "Effective community-local cap on active user-owned agents per human owner.\n"
          },
          "accepted_agent_ownership_providers": {
            "type": "array",
            "description": "Resolved effective accepted agent-ownership providers for this community. The server must\nalways return the concrete effective provider set on reads, whether it came from an\nexplicit override or from derivation based on `human_verification_lane` and the\nunderlying trust floor.\n",
            "items": {
              "$ref": "./agents.yaml#/AgentOwnershipProvider"
            }
          },
          "accepted_agent_ownership_providers_origin": {
            "$ref": "./communities-core.yaml#/CommunityAgentResolutionOrigin",
            "description": "Whether `accepted_agent_ownership_providers` came from an explicit community override or\nfrom server-side derivation.\n"
          },
          "civic_scale_tier": {
            "type": "string",
            "enum": [
              "club",
              "village",
              "town",
              "city",
              "state"
            ],
            "description": "Derived scale label for a community. This is a presentation and progression classification, not a different base entity type.\n"
          },
          "donation_policy_mode": {
            "type": "string",
            "enum": [
              "none",
              "optional_creator_sidecar"
            ]
          },
          "donation_partner_status": {
            "type": "string",
            "enum": [
              "unconfigured",
              "active",
              "paused"
            ]
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_partner": {
            "$ref": "./communities-community.yaml#/DonationPartnerSummary",
            "nullable": true
          },
          "money_policy": {
            "$ref": "./communities-community.yaml#/CommunityMoneyPolicy",
            "description": "Resolved effective community funding policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the default policy from an explicit community configuration.\n"
          },
          "content_authenticity_policy": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityPolicy",
            "description": "Resolved effective authenticity policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the restrictive default from an explicit community configuration.\n"
          },
          "content_authenticity_detection_policy": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityDetectionPolicy",
            "description": "Resolved effective authenticity-detection policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the platform-default profile from an explicit community selection.\n"
          },
          "market_context_policy": {
            "$ref": "./market-context.yaml#/CommunityMarketContextPolicy",
            "description": "Resolved effective market-context policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the platform-default policy from an explicit community configuration.\n"
          },
          "source_policy": {
            "$ref": "./communities-community.yaml#/CommunitySourcePolicy",
            "description": "Resolved effective source policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the restrictive default from an explicit community configuration.\n"
          },
          "capture_edit_policy": {
            "$ref": "./communities-community.yaml#/CommunityCaptureEditPolicy",
            "description": "Resolved effective capture-edit policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the default from an explicit community configuration.\n"
          },
          "adult_content_policy": {
            "$ref": "./communities-community.yaml#/CommunityAdultContentPolicy",
            "description": "Resolved effective adult-content policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the default from an explicit community configuration.\n"
          },
          "graphic_content_policy": {
            "$ref": "./communities-community.yaml#/CommunityGraphicContentPolicy",
            "description": "Resolved effective graphic-content policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the default from an explicit community configuration.\n"
          },
          "motion_media_policy": {
            "$ref": "./communities-community.yaml#/CommunityMotionMediaPolicy",
            "description": "Resolved effective motion-media policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the default from an explicit community configuration.\n"
          },
          "language_policy": {
            "$ref": "./communities-community.yaml#/CommunityLanguagePolicy",
            "description": "Resolved effective language policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the default from an explicit community configuration.\n"
          },
          "civility_policy": {
            "$ref": "./communities-community.yaml#/CommunityCivilityPolicy",
            "description": "Resolved effective civility policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the default from an explicit community configuration.\n"
          },
          "openai_moderation_settings": {
            "type": "object",
            "nullable": true,
            "additionalProperties": false,
            "properties": {
              "scan_titles": {
                "type": "boolean"
              },
              "scan_post_bodies": {
                "type": "boolean"
              },
              "scan_captions": {
                "type": "boolean"
              },
              "scan_link_preview_text": {
                "type": "boolean"
              },
              "scan_images": {
                "type": "boolean"
              }
            },
            "description": "Optional moderation-scan toggles persisted in community settings for text and image\nsurfaces. Null means the community is using the platform default moderation scan profile.\n"
          },
          "provenance_policy": {
            "$ref": "./communities-community.yaml#/CommunityProvenancePolicy",
            "description": "Resolved effective provenance policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the default from an explicit community configuration.\n"
          },
          "promotion_policy": {
            "$ref": "./communities-community.yaml#/CommunityPromotionPolicy",
            "description": "Resolved effective promotion policy returned on community reads. This object must be returned even when the stored policy is unset; use `policy_origin` to distinguish the default from an explicit community configuration.\n"
          },
          "label_policy": {
            "$ref": "./communities-community.yaml#/CommunityLabelPolicy",
            "nullable": true
          },
          "community_profile": {
            "$ref": "./communities-community.yaml#/CommunityProfile",
            "nullable": true
          },
          "reference_links": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityReferenceLinkPublic"
            },
            "nullable": true
          },
          "community_stage": {
            "type": "string",
            "enum": [
              "initial"
            ],
            "description": "Derived server-side community maturity state. This is never a create input. `initial` is the only guaranteed cross-implementation value for public v0. Servers may define additional stage values. New communities start at the initial stage, and later stage progression depends on platform-defined `qualified_member_count` thresholds.\n"
          },
          "member_count": {
            "type": "integer",
            "nullable": true,
            "description": "Total community membership count used for read surfaces. Raw membership alone should not unlock namespace commerce capabilities.\n"
          },
          "qualified_member_count": {
            "type": "integer",
            "nullable": true,
            "description": "Derived count used for community-stage progression and namespace-commerce unlocks. This count is platform-defined and should exclude members that do not satisfy the platform's qualification rules for economic unlocks.\n"
          },
          "stage_entered_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true,
            "description": "Timestamp when the community most recently entered its current derived `community_stage`.\n"
          },
          "governance_mode": {
            "type": "string",
            "enum": [
              "centralized",
              "multisig",
              "majeur"
            ]
          },
          "governance_backend": {
            "$ref": "./communities-governance.yaml#/CommunityGovernanceBackend",
            "nullable": true
          },
          "gate_rules": {
            "type": "array",
            "items": {
              "$ref": "./communities-core.yaml#/GateRule"
            },
            "nullable": true
          },
          "created_by_user_id": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateLiveRoomRequest": {
        "type": "object",
        "required": [
          "title",
          "access_mode",
          "room_kind",
          "visibility",
          "performer_allocations",
          "initial_setlist"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "event_start_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "access_mode": {
            "type": "string",
            "enum": [
              "free",
              "gated",
              "paid"
            ]
          },
          "room_kind": {
            "type": "string",
            "enum": [
              "solo",
              "duet"
            ]
          },
          "visibility": {
            "type": "string",
            "enum": [
              "public",
              "unlisted"
            ]
          },
          "guest_user_id": {
            "type": "string",
            "nullable": true
          },
          "performer_allocations": {
            "type": "array",
            "minItems": 1,
            "items": {
              "$ref": "./livestreams.yaml#/LiveRoomPerformerAllocationInput"
            }
          },
          "cover_ref": {
            "type": "string",
            "nullable": true
          },
          "participant_capacity": {
            "type": "integer",
            "nullable": true
          },
          "listing_id": {
            "type": "string",
            "nullable": true
          },
          "replay_listing_id": {
            "type": "string",
            "nullable": true
          },
          "anchor_post_id": {
            "type": "string",
            "nullable": true
          },
          "initial_setlist": {
            "$ref": "./livestreams.yaml#/InitialLiveSetlistInput"
          }
        }
      },
      "InitialLiveSetlistInput": {
        "type": "object",
        "description": "Initial setlist payload required when creating a live room. The setlist may begin in `draft` state, but it must exist from creation time onward.\n",
        "required": [
          "status",
          "items"
        ],
        "properties": {
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "active"
            ]
          },
          "items": {
            "type": "array",
            "minItems": 1,
            "items": {
              "$ref": "./livestreams.yaml#/LiveSetlistItemInput"
            }
          }
        }
      },
      "LiveSetlistItemInput": {
        "type": "object",
        "description": "Setlist items should resolve against Pirate's canonical track catalog by default. `title_text` and `artist_text` are display snapshots populated from the selected canonical track when available, with manual text entry used only as fallback when canonical resolution is not yet available.\n",
        "anyOf": [
          {
            "required": [
              "declared_track_id"
            ]
          },
          {
            "required": [
              "title_text"
            ]
          }
        ],
        "required": [
          "sequence_index"
        ],
        "properties": {
          "sequence_index": {
            "type": "integer",
            "minimum": 0
          },
          "title_text": {
            "type": "string",
            "nullable": true
          },
          "artist_text": {
            "type": "string",
            "nullable": true
          },
          "declared_track_id": {
            "type": "string",
            "nullable": true
          },
          "notes": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "LiveRoomPerformerAllocationInput": {
        "type": "object",
        "description": "Explicit performer-side revenue allocation for the room. In v0, solo rooms should provide one host allocation at 100, and duet rooms should provide two allocations whose shares sum to 100.\n",
        "required": [
          "user_id",
          "role",
          "share_pct"
        ],
        "properties": {
          "user_id": {
            "type": "string"
          },
          "role": {
            "type": "string",
            "enum": [
              "host",
              "guest"
            ]
          },
          "share_pct": {
            "type": "number",
            "minimum": 0,
            "maximum": 100
          }
        }
      },
      "LiveRoom": {
        "type": "object",
        "required": [
          "live_room_id",
          "community_id",
          "anchor_post_id",
          "host_user_id",
          "title",
          "status",
          "access_mode",
          "room_kind",
          "visibility",
          "performer_allocations",
          "replay_status",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "live_room_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "anchor_post_id": {
            "type": "string"
          },
          "host_user_id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "scheduled",
              "live",
              "ended",
              "canceled"
            ]
          },
          "access_mode": {
            "type": "string",
            "enum": [
              "free",
              "gated",
              "paid"
            ]
          },
          "room_kind": {
            "type": "string",
            "enum": [
              "solo",
              "duet"
            ]
          },
          "visibility": {
            "type": "string",
            "enum": [
              "public",
              "unlisted"
            ]
          },
          "guest_user_id": {
            "type": "string",
            "nullable": true
          },
          "performer_allocations": {
            "type": "array",
            "items": {
              "$ref": "./livestreams.yaml#/LiveRoomPerformerAllocationInput"
            }
          },
          "listing_id": {
            "type": "string",
            "nullable": true
          },
          "replay_listing_id": {
            "type": "string",
            "nullable": true
          },
          "broadcast_ref": {
            "type": "string",
            "nullable": true
          },
          "event_start_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "live_started_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "ended_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "canceled_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "cover_ref": {
            "type": "string",
            "nullable": true
          },
          "participant_capacity": {
            "type": "integer",
            "nullable": true
          },
          "replay_asset_id": {
            "type": "string",
            "nullable": true
          },
          "replay_status": {
            "type": "string",
            "enum": [
              "none",
              "processing",
              "review_pending",
              "published",
              "failed"
            ]
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "HostAttachRequest": {
        "type": "object",
        "description": "Optional host-attach request parameters. The host-attach flow is idempotent for a given host session and may refresh credentials.\n",
        "properties": {
          "client_kind": {
            "type": "string",
            "enum": [
              "web_host_console",
              "desktop_native"
            ]
          },
          "refresh": {
            "type": "boolean",
            "default": false
          }
        }
      },
      "GuestAttachRequest": {
        "type": "object",
        "description": "Optional guest-attach request parameters. The caller must match the invited collaborator for the room.\n",
        "properties": {
          "client_kind": {
            "type": "string",
            "enum": [
              "desktop_native",
              "web_host_console"
            ]
          },
          "refresh": {
            "type": "boolean",
            "default": false
          }
        }
      },
      "LiveRoomAttachSession": {
        "type": "object",
        "required": [
          "live_room_id",
          "broadcast_ref",
          "agora_channel",
          "agora_role",
          "agora_token",
          "bridge_token",
          "expires_at"
        ],
        "properties": {
          "live_room_id": {
            "type": "string"
          },
          "broadcast_ref": {
            "type": "string"
          },
          "agora_channel": {
            "type": "string"
          },
          "agora_role": {
            "type": "string",
            "enum": [
              "host",
              "guest"
            ]
          },
          "agora_token": {
            "type": "string"
          },
          "bridge_token": {
            "type": "string"
          },
          "route_base": {
            "type": "string",
            "nullable": true
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "LiveRoomAccessView": {
        "type": "object",
        "required": [
          "live_room_id",
          "access_mode",
          "join_state",
          "viewer_entitled"
        ],
        "properties": {
          "live_room_id": {
            "type": "string"
          },
          "access_mode": {
            "type": "string",
            "enum": [
              "free",
              "gated",
              "paid"
            ]
          },
          "join_state": {
            "type": "string",
            "enum": [
              "allowed",
              "gate_failed",
              "payment_required",
              "not_live",
              "ended",
              "canceled"
            ]
          },
          "listing_id": {
            "type": "string",
            "nullable": true
          },
          "replay_listing_id": {
            "type": "string",
            "nullable": true
          },
          "viewer_entitled": {
            "type": "boolean"
          },
          "replay_included": {
            "type": "boolean",
            "nullable": true
          },
          "replay_available": {
            "type": "boolean"
          },
          "reason": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "LiveRoomReplayView": {
        "type": "object",
        "required": [
          "live_room_id",
          "anchor_post_id",
          "replay_status",
          "is_playable",
          "is_purchasable",
          "viewer_entitled"
        ],
        "properties": {
          "live_room_id": {
            "type": "string"
          },
          "anchor_post_id": {
            "type": "string"
          },
          "replay_status": {
            "type": "string",
            "enum": [
              "none",
              "processing",
              "review_pending",
              "published",
              "failed"
            ]
          },
          "replay_asset_id": {
            "type": "string",
            "nullable": true
          },
          "replay_listing_id": {
            "type": "string",
            "nullable": true
          },
          "is_playable": {
            "type": "boolean"
          },
          "is_purchasable": {
            "type": "boolean"
          },
          "viewer_entitled": {
            "type": "boolean"
          },
          "preview_ref": {
            "type": "string",
            "nullable": true
          },
          "reason": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "LiveRoomReplayAccessView": {
        "type": "object",
        "required": [
          "live_room_id",
          "replay_status",
          "access_state"
        ],
        "properties": {
          "live_room_id": {
            "type": "string"
          },
          "replay_status": {
            "type": "string",
            "enum": [
              "none",
              "processing",
              "review_pending",
              "published",
              "failed"
            ]
          },
          "access_state": {
            "type": "string",
            "enum": [
              "not_available",
              "processing",
              "under_review",
              "allowed",
              "purchase_required",
              "failed"
            ]
          },
          "replay_asset_id": {
            "type": "string",
            "nullable": true
          },
          "replay_listing_id": {
            "type": "string",
            "nullable": true
          },
          "reason": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "MembershipResult": {
        "type": "object",
        "required": [
          "community_id",
          "status"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "joined",
              "requested",
              "left"
            ]
          }
        }
      },
      "CommunityFollowResponse": {
        "type": "object",
        "required": [
          "community_id",
          "following"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "following": {
            "type": "boolean"
          },
          "follower_count": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "CreateCommunityDonationPolicyInput": {
        "type": "object",
        "description": "Optional community-level donation configuration supplied at creation time. If omitted, the community defaults to no donation policy. If `donation_policy_mode = optional_creator_sidecar` or `fundraiser_default`, `donation_partner_id` must be non-null. If `donation_policy_mode = none`, `donation_partner_id` must be null.\n",
        "required": [
          "donation_policy_mode"
        ],
        "properties": {
          "donation_policy_mode": {
            "type": "string",
            "enum": [
              "none",
              "optional_creator_sidecar",
              "fundraiser_default"
            ]
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "UpdateCommunityDonationPolicyRequest": {
        "type": "object",
        "description": "Update the community donation policy. If `donation_policy_mode = optional_creator_sidecar` or `fundraiser_default`, `donation_partner_id` must be non-null. If `donation_policy_mode = none`, `donation_partner_id` must be null. Donation partner lifecycle management is platform-admin-controlled in v0.\n",
        "required": [
          "donation_policy_mode"
        ],
        "properties": {
          "donation_policy_mode": {
            "type": "string",
            "enum": [
              "none",
              "optional_creator_sidecar",
              "fundraiser_default"
            ]
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_partner_status": {
            "type": "string",
            "enum": [
              "unconfigured",
              "active",
              "paused"
            ],
            "nullable": true
          }
        }
      },
      "DonationPartnerSummary": {
        "type": "object",
        "description": "Public/admin-safe summary of a reviewed donation partner. Full payout routing details remain internal to Pirate settlement systems in v0.\n",
        "required": [
          "donation_partner_id",
          "display_name",
          "provider",
          "review_status",
          "status"
        ],
        "properties": {
          "donation_partner_id": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "provider": {
            "type": "string",
            "enum": [
              "endaoment"
            ]
          },
          "provider_partner_ref": {
            "type": "string",
            "nullable": true
          },
          "image_url": {
            "type": "string",
            "nullable": true
          },
          "review_status": {
            "type": "string",
            "enum": [
              "pending",
              "approved",
              "rejected"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "paused",
              "retired"
            ]
          }
        }
      },
      "CommunityDonationPolicy": {
        "type": "object",
        "description": "Resolved donation policy attached to a community. This policy enables or disables listing-level creator donation sidecars for content sold inside the community.\n",
        "required": [
          "community_id",
          "donation_policy_mode",
          "donation_partner_status"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "donation_policy_mode": {
            "type": "string",
            "enum": [
              "none",
              "optional_creator_sidecar"
            ]
          },
          "donation_partner_status": {
            "type": "string",
            "enum": [
              "unconfigured",
              "active",
              "paused"
            ]
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_partner": {
            "$ref": "./communities-community.yaml#/DonationPartnerSummary",
            "nullable": true
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityMarketContextPolicyInput": {
        "type": "object",
        "description": "Structured community setting for enabling related market context on eligible posts. V1 exposes only a small community tuning surface; Pirate keeps match-confidence thresholds, provider-specific logic, and rate-limit behavior platform-managed.\n",
        "required": [
          "mode"
        ],
        "additionalProperties": false,
        "properties": {
          "mode": {
            "$ref": "./market-context.yaml#/CommunityMarketContextMode"
          },
          "enabled_post_types": {
            "type": "array",
            "nullable": true,
            "description": "Eligible post types for market-context attachment. V1 should accept only `link`; later versions may widen this to `image` and `video`.\n",
            "items": {
              "type": "string",
              "enum": [
                "link",
                "image",
                "video"
              ]
            }
          },
          "max_markets_per_post": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3,
            "nullable": true,
            "description": "Maximum number of attached market rows returned on read surfaces. When omitted, the server should resolve the platform default.\n"
          },
          "provider_set": {
            "allOf": [
              {
                "$ref": "./market-context.yaml#/CommunityMarketContextProviderSet"
              }
            ],
            "nullable": true
          },
          "market_context_profile_id": {
            "type": "string",
            "nullable": true,
            "description": "Required when `provider_set = approved_profile`. Must reference an active platform-approved market-context profile.\n"
          }
        }
      },
      "UpdateCommunityMarketContextPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's market-context policy. Changes apply prospectively for new and newly refreshed attachments. Flipping `mode` from `on` to `off` prevents new attachments but does not retroactively detach already attached rows.\n",
        "required": [
          "mode"
        ],
        "additionalProperties": false,
        "properties": {
          "mode": {
            "$ref": "./market-context.yaml#/CommunityMarketContextMode"
          },
          "enabled_post_types": {
            "type": "array",
            "nullable": true,
            "description": "Eligible post types for market-context attachment. V1 should accept only `link`; later versions may widen this to `image` and `video`.\n",
            "items": {
              "type": "string",
              "enum": [
                "link",
                "image",
                "video"
              ]
            }
          },
          "max_markets_per_post": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3,
            "nullable": true
          },
          "provider_set": {
            "allOf": [
              {
                "$ref": "./market-context.yaml#/CommunityMarketContextProviderSet"
              }
            ],
            "nullable": true
          },
          "market_context_profile_id": {
            "type": "string",
            "nullable": true,
            "description": "Required when `provider_set = approved_profile`. Must reference an active platform-approved market-context profile.\n"
          }
        }
      },
      "MarketContextProfileSummary": {
        "type": "object",
        "description": "Public/admin-safe summary of a platform-approved market-context profile. Communities select from Pirate-managed provider sets rather than configuring raw provider hostnames, thresholds, or search logic directly.\n",
        "required": [
          "market_context_profile_id",
          "profile_key",
          "provider_keys",
          "status"
        ],
        "properties": {
          "market_context_profile_id": {
            "type": "string"
          },
          "profile_key": {
            "type": "string"
          },
          "provider_keys": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "Provider implementation keys included in the resolved profile, such as `kalshi` and `polymarket`.\n"
          },
          "status": {
            "$ref": "./market-context.yaml#/MarketContextProfileStatus"
          }
        }
      },
      "CommunityMarketContextPolicy": {
        "type": "object",
        "description": "Resolved community market-context policy. When no explicit policy has been configured, the server must still return the platform-default policy with `policy_origin = default`. In v1, communities do not configure a match-confidence threshold directly; Pirate applies one platform-managed minimum uniformly across communities.\n",
        "required": [
          "community_id",
          "policy_origin",
          "mode",
          "enabled_post_types",
          "max_markets_per_post",
          "provider_set",
          "resolved_profile",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "mode": {
            "$ref": "./market-context.yaml#/CommunityMarketContextMode"
          },
          "enabled_post_types": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "link",
                "image",
                "video"
              ]
            }
          },
          "max_markets_per_post": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3
          },
          "provider_set": {
            "$ref": "./market-context.yaml#/CommunityMarketContextProviderSet"
          },
          "resolved_profile": {
            "$ref": "./market-context.yaml#/MarketContextProfileSummary"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "MarketContextSummary": {
        "type": "object",
        "description": "Public-safe market-context sidecar for a post read surface. `no_match` is a successful abstention outcome and should normally render as no visible UI module.\n",
        "required": [
          "status"
        ],
        "properties": {
          "status": {
            "type": "string",
            "enum": [
              "attached",
              "no_match"
            ]
          },
          "claim_summary": {
            "type": "string",
            "nullable": true
          },
          "markets": {
            "type": "array",
            "nullable": true,
            "description": "Attached market rows. Present only when `status = attached`.\n",
            "items": {
              "$ref": "./market-context.yaml#/MarketContextMarket"
            }
          }
        }
      },
      "MarketContextMarket": {
        "type": "object",
        "required": [
          "provider_key",
          "question",
          "outcome_yes_price",
          "market_url",
          "snapshot_at"
        ],
        "properties": {
          "provider_key": {
            "type": "string"
          },
          "question": {
            "type": "string"
          },
          "outcome_yes_price": {
            "type": "string",
            "description": "Provider-reported Yes-side price snapshot used for read-only contextual rendering. Expressed as a decimal between 0 and 1 inclusive, where 0.64 represents a 64% implied probability. The pipeline must normalize provider-native units (e.g. Kalshi cents, Polymarket cents) to this format before storage.\n"
          },
          "liquidity_score": {
            "type": "string",
            "nullable": true
          },
          "resolve_date": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "market_url": {
            "type": "string",
            "format": "uri"
          },
          "snapshot_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "HandleAvailability": {
        "type": "object",
        "required": [
          "label",
          "available",
          "eligible"
        ],
        "properties": {
          "label": {
            "type": "string"
          },
          "available": {
            "type": "boolean"
          },
          "eligible": {
            "type": "boolean"
          },
          "estimated_price_usd": {
            "type": "number",
            "nullable": true
          },
          "reason": {
            "type": "string",
            "nullable": true,
            "description": "Optional explanatory text when `eligible = false` or when availability is otherwise constrained. This may describe a claims-disabled launch posture, missing namespace delegation, governance preconditions, or policy-specific eligibility failures.\n"
          }
        }
      },
      "CommunityHandle": {
        "type": "object",
        "required": [
          "community_handle_id",
          "user_id",
          "namespace_id",
          "label",
          "status",
          "issuance_source"
        ],
        "properties": {
          "community_handle_id": {
            "type": "string"
          },
          "user_id": {
            "type": "string"
          },
          "namespace_id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "grace_period",
              "expired",
              "revoked",
              "reserved"
            ]
          },
          "issuance_source": {
            "type": "string",
            "enum": [
              "claim",
              "auction",
              "admin_grant"
            ]
          },
          "lease_started_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "lease_expires_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "SongAudioArtifactDescriptor": {
        "type": "object",
        "required": [
          "storage_ref",
          "mime_type"
        ],
        "properties": {
          "storage_ref": {
            "type": "string"
          },
          "mime_type": {
            "type": "string"
          },
          "size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          },
          "duration_ms": {
            "type": "integer",
            "nullable": true
          },
          "clip_start_ms": {
            "type": "integer",
            "nullable": true
          },
          "clip_duration_ms": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "SongImageArtifactDescriptor": {
        "type": "object",
        "required": [
          "storage_ref",
          "mime_type"
        ],
        "properties": {
          "storage_ref": {
            "type": "string"
          },
          "mime_type": {
            "type": "string"
          },
          "size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          },
          "width": {
            "type": "integer",
            "nullable": true
          },
          "height": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "SongVideoArtifactDescriptor": {
        "type": "object",
        "required": [
          "storage_ref",
          "mime_type"
        ],
        "properties": {
          "storage_ref": {
            "type": "string"
          },
          "mime_type": {
            "type": "string"
          },
          "size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          },
          "duration_ms": {
            "type": "integer",
            "nullable": true
          },
          "clip_start_ms": {
            "type": "integer",
            "nullable": true
          },
          "clip_duration_ms": {
            "type": "integer",
            "nullable": true
          },
          "width": {
            "type": "integer",
            "nullable": true
          },
          "height": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "CreateSongArtifactBundleRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "primary_audio",
          "lyrics"
        ],
        "properties": {
          "primary_audio": {
            "$ref": "./song-artifacts.yaml#/SongArtifactUploadRef"
          },
          "lyrics": {
            "type": "string",
            "description": "Plain-text lyrics used for the mainline v0 song post."
          },
          "cover_art": {
            "$ref": "./song-artifacts.yaml#/SongArtifactUploadRef",
            "nullable": true
          },
          "preview_audio": {
            "$ref": "./song-artifacts.yaml#/SongArtifactUploadRef",
            "nullable": true
          },
          "preview_window": {
            "$ref": "./song-artifacts.yaml#/SongPreviewWindow",
            "nullable": true
          },
          "canvas_video": {
            "$ref": "./song-artifacts.yaml#/SongArtifactUploadRef",
            "nullable": true
          },
          "instrumental_audio": {
            "$ref": "./song-artifacts.yaml#/SongArtifactUploadRef",
            "nullable": true
          },
          "vocal_audio": {
            "$ref": "./song-artifacts.yaml#/SongArtifactUploadRef",
            "nullable": true
          }
        }
      },
      "CreateSongArtifactUploadRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "artifact_kind",
          "mime_type"
        ],
        "properties": {
          "artifact_kind": {
            "type": "string",
            "enum": [
              "primary_audio",
              "cover_art",
              "preview_audio",
              "canvas_video",
              "instrumental_audio",
              "vocal_audio",
              "primary_video"
            ]
          },
          "mime_type": {
            "type": "string"
          },
          "filename": {
            "type": "string",
            "nullable": true
          },
          "size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "SongArtifactUploadContentRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "content_base64"
        ],
        "properties": {
          "content_base64": {
            "type": "string"
          }
        }
      },
      "SongArtifactUpload": {
        "type": "object",
        "required": [
          "song_artifact_upload_id",
          "community_id",
          "uploader_user_id",
          "artifact_kind",
          "status",
          "storage_ref",
          "mime_type",
          "upload_url",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "song_artifact_upload_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "uploader_user_id": {
            "type": "string"
          },
          "artifact_kind": {
            "type": "string",
            "enum": [
              "primary_audio",
              "cover_art",
              "preview_audio",
              "canvas_video",
              "instrumental_audio",
              "vocal_audio",
              "primary_video"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "pending_upload",
              "uploaded",
              "failed"
            ]
          },
          "storage_ref": {
            "type": "string"
          },
          "mime_type": {
            "type": "string"
          },
          "filename": {
            "type": "string",
            "nullable": true
          },
          "size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          },
          "storage_provider": {
            "type": "string",
            "nullable": true,
            "enum": [
              "filebase",
              "local_dev_file_storage"
            ]
          },
          "storage_bucket": {
            "type": "string",
            "nullable": true
          },
          "storage_object_key": {
            "type": "string",
            "nullable": true
          },
          "storage_endpoint": {
            "type": "string",
            "nullable": true
          },
          "gateway_url": {
            "type": "string",
            "nullable": true
          },
          "upload_url": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "SongArtifactBundle": {
        "type": "object",
        "required": [
          "song_artifact_bundle_id",
          "community_id",
          "creator_user_id",
          "status",
          "primary_audio",
          "media_refs",
          "lyrics",
          "lyrics_sha256",
          "preview_status",
          "translation_status",
          "alignment_status",
          "moderation_status",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "song_artifact_bundle_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "creator_user_id": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "validating",
              "ready",
              "consuming",
              "consumed",
              "failed"
            ]
          },
          "primary_audio": {
            "$ref": "./song-artifacts.yaml#/SongAudioArtifactDescriptor"
          },
          "media_refs": {
            "type": "array",
            "description": "Mainline post-create media refs derived from the bundle. In the first v0 slice this contains only the primary audio descriptor.\n",
            "items": {
              "$ref": "./posts.yaml#/MediaDescriptor"
            }
          },
          "lyrics": {
            "type": "string"
          },
          "lyrics_sha256": {
            "type": "string",
            "description": "SHA-256 digest of `lyrics`, prefixed with `0x`."
          },
          "cover_art": {
            "$ref": "./song-artifacts.yaml#/SongImageArtifactDescriptor",
            "nullable": true
          },
          "preview_audio": {
            "$ref": "./song-artifacts.yaml#/SongAudioArtifactDescriptor",
            "nullable": true
          },
          "preview_window": {
            "$ref": "./song-artifacts.yaml#/SongPreviewWindow",
            "nullable": true
          },
          "preview_status": {
            "type": "string",
            "enum": [
              "pending",
              "processing",
              "completed",
              "failed"
            ]
          },
          "preview_error": {
            "type": "string",
            "nullable": true
          },
          "canvas_video": {
            "$ref": "./song-artifacts.yaml#/SongVideoArtifactDescriptor",
            "nullable": true
          },
          "instrumental_audio": {
            "$ref": "./song-artifacts.yaml#/SongAudioArtifactDescriptor",
            "nullable": true
          },
          "vocal_audio": {
            "$ref": "./song-artifacts.yaml#/SongAudioArtifactDescriptor",
            "nullable": true
          },
          "translation_status": {
            "type": "string",
            "enum": [
              "pending",
              "processing",
              "completed",
              "failed"
            ]
          },
          "translation_error": {
            "type": "string",
            "nullable": true
          },
          "translated_lyrics_ref": {
            "type": "string",
            "nullable": true
          },
          "translated_lyrics": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          },
          "alignment_status": {
            "type": "string",
            "enum": [
              "pending",
              "processing",
              "completed",
              "failed"
            ]
          },
          "alignment_error": {
            "type": "string",
            "nullable": true
          },
          "timed_lyrics_ref": {
            "type": "string",
            "nullable": true
          },
          "timed_lyrics": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          },
          "moderation_status": {
            "type": "string",
            "enum": [
              "pending",
              "processing",
              "completed",
              "failed"
            ]
          },
          "moderation_error": {
            "type": "string",
            "nullable": true
          },
          "moderation_result_ref": {
            "type": "string",
            "nullable": true
          },
          "moderation_result": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreatePostRequest": {
        "type": "object",
        "description": "Canonical post-create write model. User-owned agent posting uses the same route as ordinary\nposting but must send `authorship_mode = user_agent`, `agent_id`, and `agent_action_proof`.\nIn v0, user-owned agent posts must also use `identity_mode = public`.\n\nSubtype validation rules enforced by this schema:\n- text: requires at least one of `title` or `body`; must not send `link_url`, `media_refs`, `song_artifact_bundle_id`, or `lyrics`\n- image: requires at least one item in `media_refs` (all items must be `image/*`); must not send `link_url`, `song_artifact_bundle_id`, or `lyrics`\n- video: requires at least one item in `media_refs` (at least one item must be `video/*`); commerce videos may send `access_mode`; locked videos require `license_preset`; must not send `link_url`, `song_artifact_bundle_id`, or `lyrics`\n- link: requires `link_url`; may send `title` and `body`; must not send `media_refs`, `song_artifact_bundle_id`, or `lyrics`\n- song: requires either `song_artifact_bundle_id` or both `media_refs` (at least one `audio/*`) and `lyrics`; must not send `link_url`; `identity_mode` must be `public`; original songs require `license_preset`\n",
        "oneOf": [
          {
            "description": "Text posts require at least one of `title` or `body`.",
            "required": [
              "post_type"
            ],
            "anyOf": [
              {
                "required": [
                  "title"
                ]
              },
              {
                "required": [
                  "body"
                ]
              }
            ],
            "properties": {
              "post_type": {
                "type": "string",
                "enum": [
                  "text"
                ]
              },
              "title": {
                "type": "string",
                "nullable": false
              },
              "body": {
                "type": "string",
                "nullable": false
              }
            },
            "not": {
              "anyOf": [
                {
                  "required": [
                    "link_url"
                  ]
                },
                {
                  "required": [
                    "media_refs"
                  ]
                },
                {
                  "required": [
                    "song_artifact_bundle_id"
                  ]
                },
                {
                  "required": [
                    "lyrics"
                  ]
                }
              ]
            }
          },
          {
            "description": "Image posts require at least one image in `media_refs`.",
            "required": [
              "post_type",
              "media_refs"
            ],
            "properties": {
              "post_type": {
                "type": "string",
                "enum": [
                  "image"
                ]
              },
              "title": {
                "type": "string",
                "nullable": true
              },
              "media_refs": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "./posts.yaml#/ImageMediaDescriptor"
                }
              }
            },
            "not": {
              "anyOf": [
                {
                  "required": [
                    "link_url"
                  ]
                },
                {
                  "required": [
                    "song_artifact_bundle_id"
                  ]
                },
                {
                  "required": [
                    "lyrics"
                  ]
                }
              ]
            }
          },
          {
            "description": "Video posts require at least one video in `media_refs`. When `access_mode` is present,\nthe first video media ref must resolve to an uploaded `primary_video` artifact and the\nserver creates a video commerce asset. Identity must be public for commerce video posts.\n",
            "required": [
              "post_type",
              "media_refs"
            ],
            "properties": {
              "post_type": {
                "type": "string",
                "enum": [
                  "video"
                ]
              },
              "title": {
                "type": "string",
                "nullable": true
              },
              "access_mode": {
                "type": "string",
                "enum": [
                  "public",
                  "locked"
                ]
              },
              "license_preset": {
                "type": "string",
                "enum": [
                  "non-commercial",
                  "commercial-use",
                  "commercial-remix"
                ],
                "nullable": true
              },
              "commercial_rev_share_pct": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "nullable": true
              },
              "media_refs": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "./posts.yaml#/VideoMediaDescriptor"
                }
              }
            },
            "not": {
              "anyOf": [
                {
                  "required": [
                    "link_url"
                  ]
                },
                {
                  "required": [
                    "song_artifact_bundle_id"
                  ]
                },
                {
                  "required": [
                    "lyrics"
                  ]
                }
              ]
            }
          },
          {
            "description": "Link posts require `link_url`.",
            "required": [
              "post_type",
              "link_url"
            ],
            "properties": {
              "post_type": {
                "type": "string",
                "enum": [
                  "link"
                ]
              },
              "title": {
                "type": "string",
                "nullable": true
              },
              "body": {
                "type": "string",
                "nullable": true
              },
              "link_url": {
                "type": "string",
                "format": "uri",
                "nullable": false
              }
            },
            "not": {
              "anyOf": [
                {
                  "required": [
                    "media_refs"
                  ]
                },
                {
                  "required": [
                    "song_artifact_bundle_id"
                  ]
                },
                {
                  "required": [
                    "lyrics"
                  ]
                }
              ]
            }
          },
          {
            "description": "Song posts require either `song_artifact_bundle_id` or both `media_refs` (at least one `audio/*`) and `lyrics`. Identity must be public.\n`access_mode = locked` is only supported for bundle-backed song posts so the post can expose preview-safe media while the asset keeps the full payload gated.\nWhen `rights_basis = derivative` or `song_mode = remix`, `upstream_asset_refs` must contain at least one entry; this is enforced server-side.\n",
            "required": [
              "post_type",
              "identity_mode"
            ],
            "anyOf": [
              {
                "required": [
                  "song_artifact_bundle_id"
                ]
              },
              {
                "allOf": [
                  {
                    "required": [
                      "media_refs"
                    ]
                  },
                  {
                    "required": [
                      "lyrics"
                    ]
                  }
                ]
              }
            ],
            "properties": {
              "post_type": {
                "type": "string",
                "enum": [
                  "song"
                ]
              },
              "identity_mode": {
                "type": "string",
                "enum": [
                  "public"
                ]
              },
              "access_mode": {
                "type": "string",
                "enum": [
                  "public",
                  "locked"
                ]
              },
              "license_preset": {
                "type": "string",
                "enum": [
                  "non-commercial",
                  "commercial-use",
                  "commercial-remix"
                ],
                "nullable": true
              },
              "commercial_rev_share_pct": {
                "type": "integer",
                "minimum": 0,
                "maximum": 100,
                "nullable": true
              },
              "title": {
                "type": "string",
                "nullable": true
              },
              "media_refs": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "./posts.yaml#/AudioMediaDescriptor"
                }
              }
            },
            "not": {
              "anyOf": [
                {
                  "required": [
                    "link_url"
                  ]
                },
                {
                  "allOf": [
                    {
                      "required": [
                        "song_artifact_bundle_id"
                      ]
                    },
                    {
                      "required": [
                        "media_refs"
                      ]
                    }
                  ]
                },
                {
                  "allOf": [
                    {
                      "required": [
                        "song_artifact_bundle_id"
                      ]
                    },
                    {
                      "required": [
                        "lyrics"
                      ]
                    }
                  ]
                }
              ]
            }
          }
        ],
        "required": [
          "idempotency_key",
          "post_type"
        ],
        "properties": {
          "idempotency_key": {
            "type": "string",
            "description": "Client-supplied deduplication key for create retries. For the same authenticated author,\nreusing the same `idempotency_key` on an equivalent create request must return the\noriginally created post rather than creating a duplicate row.\n"
          },
          "authorship_mode": {
            "type": "string",
            "enum": [
              "human_direct",
              "user_agent"
            ],
            "default": "human_direct",
            "description": "Audit field for distinguishing human-direct writes from user-owned agent writes.\n"
          },
          "agent_id": {
            "type": "string",
            "nullable": true,
            "description": "Required when `authorship_mode = user_agent`. Must be null when `authorship_mode = human_direct`.\n"
          },
          "agent_action_proof": {
            "$ref": "./agents.yaml#/AgentActionProof",
            "nullable": true,
            "description": "Required when `authorship_mode = user_agent`. The server must verify this proof against the\nactive agent ownership record before accepting the post. For canonical request hashing,\npublic v0 excludes this field itself from the canonical request body so the request does\nnot recursively sign its own proof envelope.\n"
          },
          "identity_mode": {
            "type": "string",
            "enum": [
              "public",
              "anonymous"
            ],
            "default": "public"
          },
          "anonymous_scope": {
            "type": "string",
            "enum": [
              "community_stable",
              "thread_stable",
              "post_ephemeral"
            ],
            "nullable": true,
            "description": "Required when `identity_mode = anonymous`. Must be null when `identity_mode = public`.\n"
          },
          "disclosed_qualifier_ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true,
            "description": "Platform-defined `qualifier_template_id` values chosen by the author for this post. In v0 these are only valid when `identity_mode = anonymous`.\n"
          },
          "parent_post_id": {
            "type": "string",
            "nullable": true
          },
          "label_id": {
            "type": "string",
            "nullable": true
          },
          "label_assignment_status": {
            "type": "string",
            "enum": [
              "pending",
              "assigned",
              "failed",
              "skipped"
            ],
            "nullable": true
          },
          "label_assigned_by": {
            "type": "string",
            "enum": [
              "moderator",
              "ai"
            ],
            "nullable": true
          },
          "label_assigned_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "label_ai_confidence": {
            "type": "number",
            "nullable": true,
            "minimum": 0,
            "maximum": 1
          },
          "label_assignment_error": {
            "type": "string",
            "nullable": true
          },
          "label_assignment_model": {
            "type": "string",
            "nullable": true
          },
          "label_assignment_result_json": {
            "type": "object",
            "additionalProperties": true,
            "nullable": true
          },
          "post_type": {
            "type": "string",
            "enum": [
              "text",
              "image",
              "video",
              "link",
              "song"
            ]
          },
          "body": {
            "type": "string",
            "nullable": true
          },
          "caption": {
            "type": "string",
            "nullable": true
          },
          "link_url": {
            "type": "string",
            "format": "uri",
            "nullable": true,
            "description": "Required when post_type is link. Must be absent for all other post types."
          },
          "media_refs": {
            "type": "array",
            "items": {
              "$ref": "./posts.yaml#/MediaDescriptor"
            }
          },
          "creator_relation": {
            "$ref": "./posts.yaml#/PostCreatorRelation",
            "nullable": true,
            "description": "Structured claim about the author's relationship to the submitted content. Communities may require this through `provenance_policy`.\n"
          },
          "promotion_disclosure": {
            "$ref": "./posts.yaml#/PromotionDisclosureInput",
            "nullable": true,
            "description": "Structured disclosure for promotional or affiliated posts. Communities may require this through `promotion_policy`.\n"
          },
          "translation_policy": {
            "type": "string",
            "enum": [
              "none",
              "machine_allowed",
              "human_only",
              "hybrid"
            ]
          },
          "visibility": {
            "type": "string",
            "enum": [
              "public",
              "members_only"
            ],
            "default": "public"
          },
          "access_mode": {
            "type": "string",
            "description": "Asset access mode for commerce-backed song and video posts. `public` keeps the source payload public.\n`locked` creates a locked asset and gates the full payload through the asset access flow.\n",
            "enum": [
              "public",
              "locked"
            ],
            "nullable": true
          },
          "asset_id": {
            "type": "string",
            "nullable": true
          },
          "song_artifact_bundle_id": {
            "type": "string",
            "nullable": true,
            "description": "Canonical song artifact bundle reference for bundle-backed song posts. When provided for `post_type = song`,\nclients must not also send `lyrics` or `media_refs`; the server derives those from the bundle.\n"
          },
          "song_mode": {
            "type": "string",
            "enum": [
              "original",
              "remix"
            ],
            "nullable": true
          },
          "rights_basis": {
            "type": "string",
            "enum": [
              "none",
              "original",
              "derivative",
              "attribution_only"
            ],
            "nullable": true
          },
          "upstream_asset_refs": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true,
            "description": "Upstream asset IDs for derivative or remix attribution.\nServer-side validation requires at least one entry when `rights_basis = derivative` or `song_mode = remix`.\nThe server must verify these assets exist and belong to the same community or a public-accessible scope.\nThis conditional requirement is enforced server-side because OpenAPI cannot express cross-field dependencies.\n"
          },
          "license_preset": {
            "type": "string",
            "enum": [
              "non-commercial",
              "commercial-use",
              "commercial-remix"
            ],
            "nullable": true,
            "description": "Required for original song posts and locked original video posts. Selects the Story PIL flavor for the newly published asset.\nRemix/derivative posts inherit/accept source terms separately and must not send outbound license terms in v0.\n"
          },
          "commercial_rev_share_pct": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100,
            "nullable": true,
            "description": "Required only when `license_preset = commercial-remix`. This is the share derivative revenue owes back to the original asset.\n"
          },
          "lyrics": {
            "type": "string",
            "nullable": true,
            "description": "Plain-text lyrics for song posts. Required when post_type is song. Optional for other post types.\n"
          }
        }
      },
      "Post": {
        "type": "object",
        "description": "Canonical post row. User-owned agent posts keep the owning human in `author_user_id` while\nexposing explicit authorship and byline snapshot fields for auditability and rendering.\n",
        "required": [
          "post_id",
          "community_id",
          "authorship_mode",
          "identity_mode",
          "post_type",
          "status",
          "visibility",
          "analysis_state",
          "content_safety_state",
          "age_gate_policy",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "post_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "author_user_id": {
            "type": "string",
            "nullable": true,
            "description": "Public read models omit this field for anonymous posts. It remains present for non-anonymous posts and privileged internal reads.\n"
          },
          "authorship_mode": {
            "type": "string",
            "enum": [
              "human_direct",
              "user_agent"
            ]
          },
          "agent_id": {
            "type": "string",
            "nullable": true,
            "description": "Present when `authorship_mode = user_agent`.\n"
          },
          "agent_ownership_record_id": {
            "type": "string",
            "nullable": true,
            "description": "Audit anchor for the ownership interval that applied when the post was published. Historical\nrendering must not depend on re-resolving the current live ownership record.\n"
          },
          "identity_mode": {
            "type": "string",
            "enum": [
              "public",
              "anonymous"
            ]
          },
          "anonymous_scope": {
            "type": "string",
            "enum": [
              "community_stable",
              "thread_stable",
              "post_ephemeral"
            ],
            "nullable": true
          },
          "anonymous_label": {
            "type": "string",
            "nullable": true
          },
          "agent_handle_snapshot": {
            "type": "string",
            "nullable": true,
            "description": "Required on new `user_agent` posts. Stores the canonical `.clawitzer` handle snapshot used\nfor historical rendering and moderation review.\n"
          },
          "agent_display_name_snapshot": {
            "type": "string",
            "nullable": true,
            "description": "Required on `user_agent` posts. Write-time snapshot used for feed and thread rendering.\n"
          },
          "agent_owner_handle_snapshot": {
            "type": "string",
            "nullable": true,
            "description": "Required on `user_agent` posts. Stores the owner's global `.pirate` handle snapshot used\nfor cross-surface byline rendering without joining the current live ownership record.\n"
          },
          "agent_ownership_provider_snapshot": {
            "type": "string",
            "nullable": true,
            "description": "Optional provider snapshot for user-agent bylines or moderation context.\n"
          },
          "disclosed_qualifiers_json": {
            "type": "array",
            "items": {
              "$ref": "./posts.yaml#/DisclosedQualifierSnapshot"
            },
            "nullable": true
          },
          "label_id": {
            "type": "string",
            "nullable": true
          },
          "post_type": {
            "type": "string",
            "enum": [
              "text",
              "image",
              "video",
              "link",
              "song"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "published",
              "hidden",
              "removed",
              "deleted"
            ]
          },
          "visibility": {
            "type": "string",
            "enum": [
              "public",
              "members_only"
            ]
          },
          "title": {
            "type": "string",
            "nullable": true
          },
          "body": {
            "type": "string",
            "nullable": true
          },
          "caption": {
            "type": "string",
            "nullable": true
          },
          "link_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          },
          "link_og_image_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          },
          "link_og_title": {
            "type": "string",
            "nullable": true
          },
          "embeds": {
            "type": "array",
            "items": {
              "$ref": "./posts.yaml#/PostEmbed"
            },
            "nullable": true,
            "description": "Structured embeds hydrated from supported link providers. Generic link previews remain\nrepresented by `link_og_title` and `link_og_image_url`; this array is reserved for\nprovider-backed embeds whose official rendering or availability must be tracked.\n"
          },
          "media_refs": {
            "type": "array",
            "items": {
              "$ref": "./posts.yaml#/MediaDescriptor"
            }
          },
          "creator_relation": {
            "$ref": "./posts.yaml#/PostCreatorRelation",
            "nullable": true
          },
          "promotion_disclosure": {
            "$ref": "./posts.yaml#/PromotionDisclosure",
            "nullable": true
          },
          "source_language": {
            "type": "string",
            "nullable": true,
            "description": "Server-authored detected source language. May be null only while `analysis_state = pending`; published posts should have a non-null value.\n"
          },
          "translation_policy": {
            "type": "string",
            "enum": [
              "none",
              "machine_allowed",
              "human_only",
              "hybrid"
            ],
            "nullable": true
          },
          "access_mode": {
            "type": "string",
            "description": "Asset access mode for the rendered post. `public` keeps the source payload public.\n`locked` means the post is backed by a locked asset and should expose only preview-safe\nmedia or metadata in ordinary reads.\n",
            "enum": [
              "public",
              "locked"
            ],
            "nullable": true
          },
          "asset_id": {
            "type": "string",
            "nullable": true
          },
          "song_artifact_bundle_id": {
            "type": "string",
            "nullable": true
          },
          "parent_post_id": {
            "type": "string",
            "nullable": true
          },
          "song_mode": {
            "type": "string",
            "enum": [
              "original",
              "remix"
            ],
            "nullable": true
          },
          "rights_basis": {
            "type": "string",
            "enum": [
              "none",
              "original",
              "derivative",
              "attribution_only"
            ],
            "nullable": true
          },
          "upstream_asset_refs": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true,
            "description": "Upstream asset IDs referenced for derivative or remix attribution. Populated when `rights_basis = derivative`\nor when analysis detected a required upstream reference.\n"
          },
          "analysis_state": {
            "type": "string",
            "enum": [
              "pending",
              "allow",
              "allow_with_required_reference",
              "review_required",
              "blocked"
            ]
          },
          "analysis_result_ref": {
            "type": "string",
            "nullable": true
          },
          "content_safety_state": {
            "type": "string",
            "enum": [
              "pending",
              "safe",
              "sensitive",
              "adult"
            ]
          },
          "age_gate_policy": {
            "type": "string",
            "enum": [
              "none",
              "18_plus"
            ]
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "LocalizedPostResponse": {
        "type": "object",
        "description": "Localized read envelope for a canonical post. Read endpoints return this wrapper so locale-resolved translation fields stay out of the canonical `Post` schema.\n",
        "required": [
          "post",
          "upvote_count",
          "downvote_count",
          "like_count",
          "viewer_vote",
          "viewer_reaction_kinds",
          "resolved_locale",
          "translation_state",
          "machine_translated",
          "source_hash",
          "thread_snapshot"
        ],
        "properties": {
          "post": {
            "$ref": "./posts.yaml#/Post"
          },
          "author_community_role": {
            "type": "string",
            "enum": [
              "owner",
              "moderator"
            ],
            "nullable": true
          },
          "thread_snapshot": {
            "$ref": "./comments.yaml#/CommentThreadSnapshot",
            "nullable": true
          },
          "market_context": {
            "$ref": "./market-context.yaml#/MarketContextSummary",
            "nullable": true
          },
          "label": {
            "$ref": "./communities-community.yaml#/PostLabel",
            "nullable": true
          },
          "upvote_count": {
            "type": "integer",
            "minimum": 0
          },
          "downvote_count": {
            "type": "integer",
            "minimum": 0
          },
          "like_count": {
            "type": "integer",
            "minimum": 0
          },
          "viewer_vote": {
            "type": "integer",
            "enum": [
              -1,
              1
            ],
            "nullable": true,
            "description": "The caller's active vote on the post. Null means the caller has not cast a vote.\n"
          },
          "viewer_reaction_kinds": {
            "type": "array",
            "description": "Active reaction kinds from the caller on this post. Empty when the caller has no active reactions.\n",
            "items": {
              "type": "string",
              "enum": [
                "like"
              ]
            }
          },
          "resolved_locale": {
            "type": "string"
          },
          "translation_state": {
            "type": "string",
            "enum": [
              "ready",
              "pending",
              "same_language",
              "policy_blocked"
            ],
            "description": "Translation resolution state for the resolved locale. `ready` means a machine translation exists. `pending` means the translation is being materialized lazily. `same_language` means no translation is needed. `policy_blocked` means `translation_policy` forbids machine translation.\n"
          },
          "machine_translated": {
            "type": "boolean",
            "description": "True only when `translation_state = ready` and translated text is being surfaced for the resolved locale.\n"
          },
          "translated_body": {
            "type": "string",
            "nullable": true,
            "description": "Viewer-facing translated body text when `translation_state = ready`.\n"
          },
          "translated_title": {
            "type": "string",
            "nullable": true,
            "description": "Viewer-facing translated title text when `translation_state = ready`.\n"
          },
          "translated_caption": {
            "type": "string",
            "nullable": true,
            "description": "Viewer-facing translated caption text when `translation_state = ready`.\n"
          },
          "source_hash": {
            "type": "string",
            "description": "Content fingerprint for translation cache invalidation. Changes when the canonical source text changes.\n"
          }
        }
      },
      "MediaDescriptor": {
        "type": "object",
        "required": [
          "storage_ref"
        ],
        "properties": {
          "storage_ref": {
            "type": "string"
          },
          "mime_type": {
            "type": "string",
            "nullable": true
          },
          "size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          },
          "duration_ms": {
            "type": "integer",
            "nullable": true
          },
          "poster_ref": {
            "type": "string",
            "nullable": true
          },
          "poster_mime_type": {
            "type": "string",
            "nullable": true
          },
          "poster_size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "poster_width": {
            "type": "integer",
            "nullable": true
          },
          "poster_height": {
            "type": "integer",
            "nullable": true
          },
          "poster_frame_ms": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "PostEmbed": {
        "oneOf": [
          {
            "$ref": "./posts.yaml#/XPostEmbed"
          },
          {
            "$ref": "./posts.yaml#/YouTubeVideoEmbed"
          }
        ]
      },
      "XEmbedPreview": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "author_name": {
            "type": "string",
            "nullable": true
          },
          "author_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          },
          "text": {
            "type": "string",
            "nullable": true
          },
          "has_media": {
            "type": "boolean"
          },
          "media_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "XPostEmbed": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "embed_id",
          "embed_key",
          "provider",
          "canonical_url",
          "original_url",
          "state"
        ],
        "properties": {
          "embed_id": {
            "type": "string"
          },
          "embed_key": {
            "type": "string"
          },
          "provider": {
            "type": "string",
            "enum": [
              "x"
            ]
          },
          "provider_ref": {
            "type": "string",
            "nullable": true
          },
          "canonical_url": {
            "type": "string",
            "format": "uri"
          },
          "original_url": {
            "type": "string",
            "format": "uri"
          },
          "state": {
            "type": "string",
            "enum": [
              "pending",
              "preview",
              "embed",
              "unavailable"
            ]
          },
          "preview": {
            "$ref": "./posts.yaml#/XEmbedPreview",
            "nullable": true
          },
          "oembed_html": {
            "type": "string",
            "nullable": true
          },
          "oembed_cache_age": {
            "type": "integer",
            "nullable": true
          },
          "unavailable_reason": {
            "type": "string",
            "enum": [
              "deleted",
              "withheld",
              "private",
              "unsupported",
              "unknown"
            ],
            "nullable": true
          },
          "last_checked_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "YouTubeEmbedPreview": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "title": {
            "type": "string",
            "nullable": true
          },
          "author_name": {
            "type": "string",
            "nullable": true
          },
          "author_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          },
          "thumbnail_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          },
          "thumbnail_width": {
            "type": "integer",
            "nullable": true
          },
          "thumbnail_height": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "YouTubeVideoEmbed": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "embed_id",
          "embed_key",
          "provider",
          "canonical_url",
          "original_url",
          "state"
        ],
        "properties": {
          "embed_id": {
            "type": "string"
          },
          "embed_key": {
            "type": "string"
          },
          "provider": {
            "type": "string",
            "enum": [
              "youtube"
            ]
          },
          "provider_ref": {
            "type": "string",
            "nullable": true
          },
          "canonical_url": {
            "type": "string",
            "format": "uri"
          },
          "original_url": {
            "type": "string",
            "format": "uri"
          },
          "state": {
            "type": "string",
            "enum": [
              "pending",
              "preview",
              "embed",
              "unavailable"
            ]
          },
          "preview": {
            "$ref": "./posts.yaml#/YouTubeEmbedPreview",
            "nullable": true
          },
          "oembed_html": {
            "type": "string",
            "nullable": true
          },
          "oembed_cache_age": {
            "type": "integer",
            "nullable": true
          },
          "unavailable_reason": {
            "type": "string",
            "enum": [
              "deleted",
              "withheld",
              "private",
              "unsupported",
              "unknown"
            ],
            "nullable": true
          },
          "last_checked_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "Question": {
        "type": "object",
        "required": [
          "question_id",
          "post_id",
          "community_id",
          "author_user_id",
          "question_kind",
          "prompt",
          "status",
          "published_at"
        ],
        "properties": {
          "question_id": {
            "type": "string"
          },
          "post_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "author_user_id": {
            "type": "string"
          },
          "question_kind": {
            "type": "string",
            "enum": [
              "meaning",
              "slang_context",
              "song_id",
              "artist_fact",
              "translation"
            ]
          },
          "prompt": {
            "type": "string"
          },
          "choices": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "correct_answer_ref": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "explanation": {
            "type": "string",
            "nullable": true
          },
          "source_type": {
            "type": "string",
            "enum": [
              "lyrics",
              "annotation",
              "artist_catalog",
              "club_lore"
            ]
          },
          "source_ref": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "published",
              "closed",
              "revealed"
            ]
          },
          "published_at": {
            "type": "string",
            "format": "date-time"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "CreateQuestionRequest": {
        "type": "object",
        "required": [
          "question_kind",
          "prompt",
          "choices",
          "correct_answer_ref"
        ],
        "properties": {
          "question_kind": {
            "type": "string",
            "enum": [
              "meaning",
              "slang_context",
              "song_id",
              "artist_fact",
              "translation"
            ]
          },
          "prompt": {
            "type": "string"
          },
          "choices": {
            "type": "array",
            "minItems": 2,
            "items": {
              "type": "string"
            }
          },
          "correct_answer_ref": {
            "type": "integer",
            "minimum": 0
          },
          "explanation": {
            "type": "string",
            "nullable": true
          },
          "source_type": {
            "type": "string",
            "enum": [
              "lyrics",
              "annotation",
              "artist_catalog",
              "club_lore"
            ]
          },
          "source_ref": {
            "type": "string",
            "nullable": true
          },
          "expires_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "QuestionAnswer": {
        "type": "object",
        "required": [
          "question_answer_id",
          "question_id",
          "user_id",
          "selected_answer_ref",
          "is_correct",
          "submitted_at"
        ],
        "properties": {
          "question_answer_id": {
            "type": "string"
          },
          "question_id": {
            "type": "string"
          },
          "user_id": {
            "type": "string"
          },
          "selected_answer_ref": {
            "type": "integer",
            "minimum": 0
          },
          "is_correct": {
            "type": "boolean",
            "nullable": true
          },
          "rewarded_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "submitted_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "FeedResponse": {
        "type": "object",
        "required": [
          "items",
          "top_communities"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./feeds.yaml#/FeedItem"
            }
          },
          "top_communities": {
            "type": "array",
            "items": {
              "$ref": "./feeds.yaml#/HomeFeedCommunitySummary"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "FeedItem": {
        "type": "object",
        "required": [
          "community",
          "post"
        ],
        "properties": {
          "community": {
            "$ref": "./feeds.yaml#/HomeFeedCommunitySummary"
          },
          "post": {
            "$ref": "./posts.yaml#/LocalizedPostResponse"
          }
        }
      },
      "CreateCommunityBootstrapInput": {
        "type": "object",
        "properties": {
          "label_policy": {
            "$ref": "./communities-community.yaml#/CreateCommunityLabelPolicyInput",
            "nullable": true
          },
          "rules": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CreateCommunityRuleInput"
            }
          },
          "resource_links": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CreateCommunityResourceLinkInput"
            }
          }
        }
      },
      "CreateCommunityLabelPolicyInput": {
        "type": "object",
        "properties": {
          "label_enabled": {
            "type": "boolean",
            "default": false
          },
          "require_label_on_top_level_posts": {
            "type": "boolean",
            "default": false
          },
          "definitions": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CreateCommunityLabelDefinitionInput"
            }
          }
        }
      },
      "UpdateCommunityLabelPolicyRequest": {
        "type": "object",
        "properties": {
          "label_enabled": {
            "type": "boolean"
          },
          "require_label_on_top_level_posts": {
            "type": "boolean"
          },
          "definitions": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityLabelDefinitionMutationInput"
            }
          }
        }
      },
      "CreateCommunityLabelDefinitionInput": {
        "type": "object",
        "required": [
          "label",
          "position"
        ],
        "additionalProperties": false,
        "properties": {
          "label": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "color_token": {
            "type": "string",
            "nullable": true
          },
          "position": {
            "type": "integer",
            "minimum": 0
          },
          "allowed_post_types": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "text",
                "image",
                "video",
                "song"
              ]
            },
            "nullable": true
          }
        }
      },
      "UpdateCommunityLabelDefinitionInput": {
        "type": "object",
        "required": [
          "label_id"
        ],
        "additionalProperties": false,
        "properties": {
          "label_id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "color_token": {
            "type": "string",
            "nullable": true
          },
          "position": {
            "type": "integer",
            "minimum": 0
          },
          "allowed_post_types": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "text",
                "image",
                "video",
                "song"
              ]
            },
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ]
          }
        }
      },
      "CommunityLabelDefinitionMutationInput": {
        "oneOf": [
          {
            "$ref": "./communities-community.yaml#/CreateCommunityLabelDefinitionInput"
          },
          {
            "$ref": "./communities-community.yaml#/UpdateCommunityLabelDefinitionInput"
          }
        ]
      },
      "CommunityLabelDefinition": {
        "type": "object",
        "required": [
          "label_id",
          "label",
          "status",
          "position"
        ],
        "properties": {
          "label_id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "color_token": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ]
          },
          "position": {
            "type": "integer",
            "minimum": 0
          },
          "allowed_post_types": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "text",
                "image",
                "video",
                "song"
              ]
            },
            "nullable": true
          }
        }
      },
      "CommunityLabelPolicy": {
        "type": "object",
        "required": [
          "label_enabled",
          "require_label_on_top_level_posts",
          "definitions"
        ],
        "properties": {
          "label_enabled": {
            "type": "boolean"
          },
          "require_label_on_top_level_posts": {
            "type": "boolean"
          },
          "definitions": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityLabelDefinition"
            }
          }
        }
      },
      "PostLabel": {
        "type": "object",
        "description": "Resolved label summary for a post read surface. Historical posts may continue to return label definitions whose current `status` is `archived`; clients should still render the label normally in that case rather than treating it as hidden or as a special archived badge.\n",
        "required": [
          "label_id",
          "label",
          "status"
        ],
        "properties": {
          "label_id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "color_token": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ]
          }
        }
      },
      "CreateCommunityRuleInput": {
        "type": "object",
        "required": [
          "title",
          "body",
          "position"
        ],
        "additionalProperties": false,
        "properties": {
          "title": {
            "type": "string"
          },
          "body": {
            "type": "string"
          },
          "report_reason": {
            "type": "string",
            "nullable": true
          },
          "position": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "UpdateCommunityRuleInput": {
        "type": "object",
        "required": [
          "rule_id"
        ],
        "additionalProperties": false,
        "properties": {
          "rule_id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "body": {
            "type": "string"
          },
          "report_reason": {
            "type": "string",
            "nullable": true
          },
          "position": {
            "type": "integer",
            "minimum": 0
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ]
          }
        }
      },
      "CommunityRuleMutationInput": {
        "oneOf": [
          {
            "$ref": "./communities-community.yaml#/CreateCommunityRuleInput"
          },
          {
            "$ref": "./communities-community.yaml#/UpdateCommunityRuleInput"
          }
        ]
      },
      "CommunityRule": {
        "type": "object",
        "required": [
          "rule_id",
          "title",
          "body",
          "report_reason",
          "position",
          "status"
        ],
        "properties": {
          "rule_id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "body": {
            "type": "string"
          },
          "report_reason": {
            "type": "string"
          },
          "position": {
            "type": "integer",
            "minimum": 0
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ]
          }
        }
      },
      "CreateCommunityResourceLinkInput": {
        "type": "object",
        "required": [
          "label",
          "url",
          "resource_kind",
          "position"
        ],
        "additionalProperties": false,
        "properties": {
          "label": {
            "type": "string"
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "resource_kind": {
            "type": "string",
            "enum": [
              "link",
              "playlist",
              "document",
              "discord",
              "website",
              "other"
            ]
          },
          "position": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "UpdateCommunityResourceLinkInput": {
        "type": "object",
        "required": [
          "resource_link_id"
        ],
        "additionalProperties": false,
        "properties": {
          "resource_link_id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "resource_kind": {
            "type": "string",
            "enum": [
              "link",
              "playlist",
              "document",
              "discord",
              "website",
              "other"
            ]
          },
          "position": {
            "type": "integer",
            "minimum": 0
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ]
          }
        }
      },
      "CommunityResourceLinkMutationInput": {
        "oneOf": [
          {
            "$ref": "./communities-community.yaml#/CreateCommunityResourceLinkInput"
          },
          {
            "$ref": "./communities-community.yaml#/UpdateCommunityResourceLinkInput"
          }
        ]
      },
      "CommunityResourceLink": {
        "type": "object",
        "required": [
          "resource_link_id",
          "label",
          "url",
          "resource_kind",
          "position",
          "status"
        ],
        "properties": {
          "resource_link_id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "resource_kind": {
            "type": "string",
            "enum": [
              "link",
              "playlist",
              "document",
              "discord",
              "website",
              "other"
            ]
          },
          "position": {
            "type": "integer",
            "minimum": 0
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ]
          }
        }
      },
      "CommunityProfile": {
        "type": "object",
        "required": [
          "rules",
          "resource_links"
        ],
        "properties": {
          "rules": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityRule"
            }
          },
          "resource_links": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityResourceLink"
            }
          }
        }
      },
      "UpdateCommunityProfileRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "display_name",
          "description",
          "avatar_ref",
          "cover_ref"
        ],
        "properties": {
          "display_name": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "cover_ref": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CommunityProfileMutationResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_id",
          "profile"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "profile": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "display_name"
            ],
            "properties": {
              "display_name": {
                "type": "string"
              },
              "description": {
                "type": "string",
                "nullable": true
              },
              "avatar_ref": {
                "type": "string",
                "nullable": true
              },
              "cover_ref": {
                "type": "string",
                "nullable": true
              }
            }
          }
        }
      },
      "UpdateCommunityRulesRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "rules"
        ],
        "properties": {
          "rules": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityRuleMutationInput"
            }
          }
        }
      },
      "CommunityRulesMutationResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_id",
          "rules"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "rules": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityRule"
            }
          },
          "rules_table_name": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "UpdateCommunityResourceLinksRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "resource_links"
        ],
        "properties": {
          "resource_links": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityResourceLinkMutationInput"
            }
          }
        }
      },
      "CommunityResourceLinksMutationResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_id",
          "resource_links"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "resource_links": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityResourceLink"
            }
          },
          "resource_links_table_name": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "TrackResolveRequest": {
        "type": "object",
        "description": "At least one identity path must be supplied. Clients may resolve by MBID, Story IP ID, metadata hash, or a metadata pair such as title plus artist display name. The server may enrich omitted metadata when a stronger identity path already exists.\n",
        "anyOf": [
          {
            "required": [
              "recording_mbid"
            ]
          },
          {
            "required": [
              "story_ip_id"
            ]
          },
          {
            "required": [
              "metadata_hash"
            ]
          },
          {
            "required": [
              "title",
              "artist_display_name"
            ]
          }
        ],
        "properties": {
          "recording_mbid": {
            "type": "string",
            "nullable": true
          },
          "story_ip_id": {
            "type": "string",
            "nullable": true
          },
          "metadata_hash": {
            "type": "string",
            "nullable": true
          },
          "asset_id": {
            "type": "string",
            "nullable": true
          },
          "community_id": {
            "type": "string",
            "nullable": true
          },
          "title": {
            "type": "string",
            "nullable": true
          },
          "artist_display_name": {
            "type": "string",
            "nullable": true
          },
          "album": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "ListingDonationConfig": {
        "type": "object",
        "description": "Listing-level creator donation sidecar configuration. When `donation_opt_in = true`, both `donation_share_pct` and `donation_partner_id_snapshot` must be non-null.\n",
        "required": [
          "donation_opt_in"
        ],
        "properties": {
          "donation_opt_in": {
            "type": "boolean"
          },
          "donation_share_pct": {
            "type": "number",
            "minimum": 0.01,
            "maximum": 50,
            "nullable": true
          },
          "donation_partner_id_snapshot": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "PurchaseDonationSettlement": {
        "type": "object",
        "description": "Purchase-time snapshot of donation routing and settlement outcome. Money fields are represented here as numbers for readability, but decimal strings are recommended in implementation to avoid floating-point precision issues.\n",
        "properties": {
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_share_pct": {
            "type": "number",
            "nullable": true
          },
          "donation_amount_usd": {
            "type": "number",
            "nullable": true
          },
          "donation_settlement_ref": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "Track": {
        "type": "object",
        "required": [
          "track_id",
          "track_kind",
          "title",
          "metadata_hash",
          "status",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "track_id": {
            "type": "string"
          },
          "track_kind": {
            "type": "string",
            "enum": [
              "mbid",
              "story_ip",
              "metadata_hash"
            ]
          },
          "recording_mbid": {
            "type": "string",
            "nullable": true
          },
          "story_ip_id": {
            "type": "string",
            "nullable": true
          },
          "asset_id": {
            "type": "string",
            "nullable": true
          },
          "community_id": {
            "type": "string",
            "nullable": true
          },
          "publisher_ref": {
            "type": "string",
            "nullable": true
          },
          "title": {
            "type": "string"
          },
          "artist_display_name": {
            "type": "string"
          },
          "album": {
            "type": "string",
            "nullable": true
          },
          "duration_ms": {
            "type": "integer",
            "nullable": true
          },
          "cover_ref": {
            "type": "string",
            "nullable": true
          },
          "lyrics_ref": {
            "type": "string",
            "nullable": true
          },
          "genius_song_id": {
            "type": "string",
            "nullable": true
          },
          "artist_identity_ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "metadata_hash": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "active",
              "deprecated"
            ]
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateScrobbleRequest": {
        "type": "object",
        "required": [
          "track_id",
          "source_type",
          "playback_started_at"
        ],
        "properties": {
          "track_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string",
            "nullable": true
          },
          "source_type": {
            "type": "string",
            "enum": [
              "web",
              "desktop",
              "mobile",
              "operator_ingested"
            ]
          },
          "playback_started_at": {
            "type": "string",
            "format": "date-time"
          },
          "playback_position_ms": {
            "type": "integer",
            "nullable": true
          },
          "credited_duration_ms": {
            "type": "integer",
            "nullable": true
          },
          "ingestion_mode": {
            "type": "string",
            "enum": [
              "first_party",
              "trusted_import"
            ],
            "default": "first_party"
          },
          "idempotency_key": {
            "type": "string"
          }
        }
      },
      "Scrobble": {
        "type": "object",
        "required": [
          "scrobble_id",
          "track_id",
          "user_id",
          "source_type",
          "playback_started_at",
          "ingestion_mode",
          "anchor_status",
          "accepted_at",
          "created_at"
        ],
        "properties": {
          "scrobble_id": {
            "type": "string"
          },
          "track_id": {
            "type": "string"
          },
          "user_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string",
            "nullable": true
          },
          "source_type": {
            "type": "string",
            "enum": [
              "web",
              "desktop",
              "mobile",
              "operator_ingested"
            ]
          },
          "playback_started_at": {
            "type": "string",
            "format": "date-time"
          },
          "playback_position_ms": {
            "type": "integer",
            "nullable": true
          },
          "credited_duration_ms": {
            "type": "integer",
            "nullable": true
          },
          "ingestion_mode": {
            "type": "string",
            "enum": [
              "first_party",
              "trusted_import"
            ]
          },
          "anchor_status": {
            "type": "string",
            "enum": [
              "queued",
              "awaiting_wallet",
              "awaiting_track",
              "anchoring",
              "anchored",
              "failed",
              "suppressed"
            ]
          },
          "accepted_at": {
            "type": "string",
            "format": "date-time"
          },
          "anchored_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "chain_tx_hash": {
            "type": "string",
            "nullable": true
          },
          "chain_log_index": {
            "type": "integer",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "ListenerSummary": {
        "type": "object",
        "required": [
          "user_id",
          "scrobble_count"
        ],
        "properties": {
          "user_id": {
            "type": "string"
          },
          "display_handle": {
            "type": "string",
            "nullable": true
          },
          "scrobble_count": {
            "type": "integer"
          }
        }
      },
      "Job": {
        "type": "object",
        "required": [
          "job_id",
          "job_type",
          "status",
          "subject_type",
          "subject_id",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "job_id": {
            "type": "string"
          },
          "job_type": {
            "type": "string",
            "enum": [
              "community_provisioning",
              "reddit_snapshot_import",
              "club_threads_export",
              "media_analysis",
              "story_publication",
              "purchase_settlement_confirmation",
              "entitlement_grant",
              "artist_metadata_enrichment",
              "track_reconciliation",
              "catalog_track_preregistration",
              "stem_separation",
              "forced_alignment",
              "karaoke_package_assembly"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "queued",
              "running",
              "succeeded",
              "failed"
            ]
          },
          "subject_type": {
            "type": "string"
          },
          "subject_id": {
            "type": "string"
          },
          "result_ref": {
            "type": "string",
            "description": "Opaque result reference. For succeeded machine-export jobs this may be a signed download URL.\n",
            "nullable": true
          },
          "error_code": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "JobAcceptedResponse": {
        "type": "object",
        "required": [
          "job"
        ],
        "properties": {
          "job": {
            "$ref": "./jobs.yaml#/Job"
          }
        }
      },
      "UserTaskType": {
        "type": "string",
        "enum": [
          "namespace_verification_required",
          "namespace_verification_pending",
          "unique_human_verification_required",
          "profile_completion_suggested",
          "global_handle_cleanup_suggested",
          "payout_setup_required",
          "royalty_claim_available",
          "membership_review"
        ]
      },
      "UserTaskStatus": {
        "type": "string",
        "enum": [
          "open",
          "completed",
          "dismissed"
        ]
      },
      "NotificationEventType": {
        "type": "string",
        "enum": [
          "comment_reply",
          "post_commented",
          "mention",
          "mod_event",
          "community_update",
          "xmtp_message",
          "royalty_earned"
        ]
      },
      "UserTask": {
        "type": "object",
        "required": [
          "task_id",
          "user_id",
          "type",
          "subject_type",
          "subject_id",
          "status",
          "priority",
          "payload",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "task_id": {
            "type": "string"
          },
          "user_id": {
            "type": "string"
          },
          "type": {
            "$ref": "./notifications.yaml#/UserTaskType"
          },
          "subject_type": {
            "type": "string"
          },
          "subject_id": {
            "type": "string"
          },
          "status": {
            "$ref": "./notifications.yaml#/UserTaskStatus"
          },
          "priority": {
            "type": "integer"
          },
          "payload": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          },
          "resolved_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "dismissed_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "NotificationEvent": {
        "type": "object",
        "required": [
          "event_id",
          "type",
          "actor_user_id",
          "subject_type",
          "subject_id",
          "created_at"
        ],
        "properties": {
          "event_id": {
            "type": "string"
          },
          "type": {
            "$ref": "./notifications.yaml#/NotificationEventType"
          },
          "actor_user_id": {
            "type": "string",
            "nullable": true
          },
          "subject_type": {
            "type": "string"
          },
          "subject_id": {
            "type": "string"
          },
          "object_type": {
            "type": "string",
            "nullable": true
          },
          "object_id": {
            "type": "string",
            "nullable": true
          },
          "payload": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "NotificationReceipt": {
        "type": "object",
        "required": [
          "event_id",
          "recipient_user_id",
          "created_at"
        ],
        "properties": {
          "event_id": {
            "type": "string"
          },
          "recipient_user_id": {
            "type": "string"
          },
          "seen_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "read_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "NotificationSummary": {
        "type": "object",
        "required": [
          "open_task_count",
          "unread_activity_count",
          "has_unread"
        ],
        "properties": {
          "open_task_count": {
            "type": "integer"
          },
          "unread_activity_count": {
            "type": "integer"
          },
          "has_unread": {
            "type": "boolean"
          }
        }
      },
      "NotificationFeedItem": {
        "type": "object",
        "required": [
          "event",
          "receipt"
        ],
        "properties": {
          "event": {
            "$ref": "./notifications.yaml#/NotificationEvent"
          },
          "receipt": {
            "$ref": "./notifications.yaml#/NotificationReceipt"
          }
        }
      },
      "NotificationFeedResponse": {
        "type": "object",
        "required": [
          "items",
          "next_cursor"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./notifications.yaml#/NotificationFeedItem"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "NotificationTasksResponse": {
        "type": "object",
        "required": [
          "items"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./notifications.yaml#/UserTask"
            }
          }
        }
      },
      "MarkNotificationsReadRequest": {
        "type": "object",
        "properties": {
          "event_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      "DismissTaskRequest": {
        "type": "object",
        "required": [
          "task_id"
        ],
        "properties": {
          "task_id": {
            "type": "string"
          }
        }
      },
      "ClaimableRoyaltyItem": {
        "type": "object",
        "required": [
          "ip_id",
          "claimable_wip_wei",
          "asset_id",
          "community_id",
          "title"
        ],
        "properties": {
          "ip_id": {
            "type": "string"
          },
          "claimable_wip_wei": {
            "type": "string"
          },
          "asset_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "title": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "ClaimableRoyaltiesResponse": {
        "type": "object",
        "required": [
          "items",
          "total_claimable_wip_wei",
          "checked_at"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./notifications.yaml#/ClaimableRoyaltyItem"
            }
          },
          "total_claimable_wip_wei": {
            "type": "string"
          },
          "checked_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "RoyaltyActivityItem": {
        "type": "object",
        "required": [
          "event_id",
          "community_id",
          "asset_id",
          "title",
          "story_ip_id",
          "amount_wip_wei",
          "buyer_wallet_address",
          "tx_hash",
          "purchase_id",
          "created_at",
          "read_at"
        ],
        "properties": {
          "event_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "asset_id": {
            "type": "string"
          },
          "title": {
            "type": "string",
            "nullable": true
          },
          "story_ip_id": {
            "type": "string"
          },
          "amount_wip_wei": {
            "type": "string"
          },
          "buyer_wallet_address": {
            "type": "string",
            "nullable": true
          },
          "tx_hash": {
            "type": "string",
            "nullable": true
          },
          "purchase_id": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "read_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "RoyaltyActivityResponse": {
        "type": "object",
        "required": [
          "items",
          "next_cursor"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./notifications.yaml#/RoyaltyActivityItem"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "RoyaltyClaimRecordRequest": {
        "type": "object",
        "required": [
          "tx_hash",
          "wallet_address",
          "chain_id",
          "claimable_wip_wei_at_submission",
          "ip_ids",
          "auto_unwrap_ip_tokens"
        ],
        "properties": {
          "tx_hash": {
            "type": "string"
          },
          "wallet_address": {
            "type": "string"
          },
          "chain_id": {
            "type": "integer"
          },
          "claimable_wip_wei_at_submission": {
            "type": "string"
          },
          "ip_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "auto_unwrap_ip_tokens": {
            "type": "boolean"
          }
        }
      },
      "RoyaltyClaimRecord": {
        "type": "object",
        "required": [
          "claim_id",
          "user_id",
          "tx_hash",
          "wallet_address",
          "chain_id",
          "claimable_wip_wei_at_submission",
          "ip_ids",
          "auto_unwrap_ip_tokens",
          "status",
          "verified_at",
          "verification_error",
          "claimed_at",
          "created_at"
        ],
        "properties": {
          "claim_id": {
            "type": "string"
          },
          "user_id": {
            "type": "string"
          },
          "tx_hash": {
            "type": "string"
          },
          "wallet_address": {
            "type": "string"
          },
          "chain_id": {
            "type": "integer"
          },
          "claimable_wip_wei_at_submission": {
            "type": "string"
          },
          "ip_ids": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "auto_unwrap_ip_tokens": {
            "type": "boolean"
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "confirmed",
              "failed"
            ]
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "verification_error": {
            "type": "string",
            "nullable": true
          },
          "claimed_at": {
            "type": "string",
            "format": "date-time"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "RoyaltyClaimHistoryResponse": {
        "type": "object",
        "required": [
          "items"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./notifications.yaml#/RoyaltyClaimRecord"
            }
          }
        }
      },
      "MppChallenge": {
        "type": "object",
        "required": [
          "code",
          "message",
          "resource_type",
          "payment_intent"
        ],
        "properties": {
          "code": {
            "type": "string",
            "enum": [
              "payment_required"
            ]
          },
          "message": {
            "type": "string"
          },
          "resource_type": {
            "type": "string"
          },
          "payment_intent": {
            "type": "string",
            "enum": [
              "charge",
              "session"
            ]
          },
          "payment_methods": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "challenge_ref": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "PaymentFailure": {
        "type": "object",
        "required": [
          "code",
          "message"
        ],
        "properties": {
          "code": {
            "type": "string",
            "enum": [
              "payment_failed"
            ]
          },
          "message": {
            "type": "string"
          },
          "retryable": {
            "type": "boolean",
            "default": false
          },
          "challenge_ref": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "ThreadExportRequest": {
        "type": "object",
        "required": [
          "format"
        ],
        "properties": {
          "format": {
            "type": "string",
            "enum": [
              "jsonl",
              "ndjson"
            ]
          },
          "include_replies": {
            "type": "boolean",
            "default": true
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100000,
            "nullable": true
          },
          "after_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "ThreadExportAcceptedResponse": {
        "type": "object",
        "required": [
          "community_id",
          "job",
          "job_status_url"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "job": {
            "$ref": "./jobs.yaml#/Job"
          },
          "job_status_url": {
            "type": "string",
            "description": "Payment-auth polling URL for this export job. App clients may instead use the bearer-auth `/jobs/{job_id}` endpoint.\n"
          }
        }
      },
      "SentinelSessionStartResponse": {
        "type": "object",
        "required": [
          "sentinel_session_id",
          "sentinel_subscription_id",
          "wallet_attachment_id",
          "wallet_address",
          "chain_session_id",
          "node_address",
          "transport_kind",
          "wireguard_config",
          "status",
          "created_now"
        ],
        "properties": {
          "sentinel_session_id": {
            "type": "string"
          },
          "sentinel_subscription_id": {
            "type": "string"
          },
          "wallet_attachment_id": {
            "type": "string"
          },
          "wallet_address": {
            "type": "string"
          },
          "chain_session_id": {
            "type": "string"
          },
          "node_address": {
            "type": "string"
          },
          "transport_kind": {
            "type": "string",
            "enum": [
              "wireguard"
            ]
          },
          "wireguard_config": {
            "type": "object",
            "required": [
              "server_endpoint",
              "server_public_key",
              "client_private_key",
              "client_address",
              "dns_servers",
              "allowed_ips"
            ],
            "properties": {
              "server_endpoint": {
                "type": "string"
              },
              "server_public_key": {
                "type": "string"
              },
              "client_private_key": {
                "type": "string",
                "nullable": true,
                "description": "Returned only on first session creation. Reused active-session responses may return `null`\ninstead of replaying the private key.\n"
              },
              "client_address": {
                "type": "string"
              },
              "dns_servers": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "allowed_ips": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          },
          "expires_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "active"
            ]
          },
          "created_now": {
            "type": "boolean"
          }
        }
      },
      "SentinelSessionEndResponse": {
        "type": "object",
        "required": [
          "sentinel_session_id",
          "status",
          "ended_at"
        ],
        "properties": {
          "sentinel_session_id": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "ended"
            ]
          },
          "ended_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "HumanVerificationLane": {
        "type": "string",
        "enum": [
          "very",
          "self"
        ],
        "description": "Primary public-v0 human-verification lane for a community. This is a simple UX-facing summary,\nnot a replacement for the underlying capability model. The server must ensure this value is\nconsistent with the community's effective gate requirements.\n"
      },
      "CommunityAgentResolutionOrigin": {
        "type": "string",
        "enum": [
          "derived",
          "explicit"
        ]
      },
      "MembershipGateSummary": {
        "type": "object",
        "required": [
          "gate_type"
        ],
        "properties": {
          "gate_type": {
            "type": "string",
            "enum": [
              "nationality",
              "gender",
              "unique_human",
              "age_over_18",
              "minimum_age",
              "wallet_score",
              "erc721_holding",
              "erc721_inventory_match"
            ]
          },
          "accepted_providers": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string",
              "enum": [
                "self",
                "very",
                "passport"
              ]
            }
          },
          "required_value": {
            "type": "string",
            "nullable": true,
            "description": "ISO 3166-1 alpha-2 or alpha-3 country code when gate_type is nationality"
          },
          "required_values": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            },
            "description": "Array of accepted ISO country codes for nationality gates"
          },
          "excluded_values": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            },
            "description": "Array of excluded ISO country codes for nationality gates"
          },
          "required_minimum_age": {
            "type": "integer",
            "nullable": true,
            "minimum": 18,
            "maximum": 125,
            "description": "Minimum age threshold when gate_type is minimum_age"
          },
          "minimum_score": {
            "type": "number",
            "nullable": true,
            "minimum": 0,
            "maximum": 100,
            "description": "Minimum Human Passport wallet score when gate_type is wallet_score"
          },
          "chain_namespace": {
            "type": "string",
            "nullable": true,
            "description": "Chain namespace for token-holding summaries. `eip155:1` for Ethereum mainnet ERC-721 gates."
          },
          "contract_address": {
            "type": "string",
            "nullable": true,
            "description": "Contract address for token-holding summaries such as Ethereum ERC-721 collection gates."
          },
          "inventory_provider": {
            "type": "string",
            "nullable": true,
            "enum": [
              "courtyard"
            ],
            "description": "Inventory provider used by ERC-721 inventory-match gates."
          },
          "min_quantity": {
            "type": "integer",
            "nullable": true,
            "minimum": 1,
            "maximum": 100,
            "description": "Minimum matching ERC-721 assets required by inventory-match gates."
          },
          "asset_filter_label": {
            "type": "string",
            "nullable": true,
            "description": "Human-readable normalized asset filter label for inventory-match gates."
          },
          "asset_category": {
            "type": "string",
            "nullable": true,
            "description": "Provider-normalized asset category for inventory-match gates, such as `trading_card` or `watch`."
          }
        }
      },
      "CommunityTextLocalization": {
        "type": "object",
        "required": [
          "resolved_locale",
          "items"
        ],
        "properties": {
          "resolved_locale": {
            "type": "string"
          },
          "items": {
            "type": "array",
            "items": {
              "$ref": "./communities-core.yaml#/CommunityTextLocalizationItem"
            }
          }
        }
      },
      "CommunityTextLocalizationItem": {
        "type": "object",
        "required": [
          "field_key",
          "translation_state",
          "machine_translated",
          "source_hash"
        ],
        "properties": {
          "field_key": {
            "type": "string"
          },
          "translation_state": {
            "type": "string",
            "enum": [
              "ready",
              "pending",
              "same_language",
              "policy_blocked"
            ]
          },
          "machine_translated": {
            "type": "boolean"
          },
          "translated_value": {
            "type": "string",
            "nullable": true
          },
          "source_hash": {
            "type": "string"
          }
        }
      },
      "CommunityRoleSummary": {
        "type": "object",
        "required": [
          "user_id",
          "display_name",
          "handle",
          "role"
        ],
        "properties": {
          "user_id": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "handle": {
            "type": "string"
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "nationality_badge_country": {
            "type": "string",
            "nullable": true
          },
          "role": {
            "type": "string",
            "enum": [
              "owner",
              "admin",
              "moderator"
            ]
          }
        }
      },
      "CommunityPreview": {
        "type": "object",
        "required": [
          "community_id",
          "display_name",
          "membership_mode",
          "human_verification_lane",
          "moderators",
          "membership_gate_summaries",
          "rules",
          "created_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "localized_text": {
            "$ref": "./communities-core.yaml#/CommunityTextLocalization",
            "nullable": true
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "banner_ref": {
            "type": "string",
            "nullable": true
          },
          "membership_mode": {
            "type": "string",
            "enum": [
              "open",
              "request",
              "gated"
            ]
          },
          "allow_anonymous_identity": {
            "type": "boolean"
          },
          "anonymous_identity_scope": {
            "type": "string",
            "enum": [
              "community_stable",
              "thread_stable",
              "post_ephemeral"
            ],
            "nullable": true
          },
          "allowed_disclosed_qualifiers": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "allow_qualifiers_on_anonymous_posts": {
            "type": "boolean",
            "nullable": true
          },
          "human_verification_lane": {
            "$ref": "./communities-core.yaml#/HumanVerificationLane"
          },
          "member_count": {
            "type": "integer",
            "nullable": true
          },
          "follower_count": {
            "type": "integer",
            "nullable": true
          },
          "donation_policy_mode": {
            "type": "string",
            "enum": [
              "none",
              "optional_creator_sidecar"
            ],
            "nullable": true
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_partner": {
            "$ref": "./communities-community.yaml#/DonationPartnerSummary",
            "nullable": true
          },
          "owner": {
            "$ref": "./communities-core.yaml#/CommunityRoleSummary",
            "nullable": true
          },
          "moderators": {
            "type": "array",
            "items": {
              "$ref": "./communities-core.yaml#/CommunityRoleSummary"
            }
          },
          "reference_links": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "./communities-community.yaml#/CommunityReferenceLinkPublic"
            }
          },
          "membership_gate_summaries": {
            "type": "array",
            "items": {
              "$ref": "./communities-core.yaml#/MembershipGateSummary"
            }
          },
          "rules": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityRule"
            }
          },
          "viewer_membership_status": {
            "type": "string",
            "enum": [
              "member",
              "not_member",
              "banned"
            ],
            "nullable": true
          },
          "viewer_following": {
            "type": "boolean",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "JoinEligibility": {
        "type": "object",
        "required": [
          "community_id",
          "membership_mode",
          "human_verification_lane",
          "joinable_now",
          "status",
          "membership_gate_summaries",
          "missing_capabilities"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "membership_mode": {
            "type": "string",
            "enum": [
              "open",
              "request",
              "gated"
            ]
          },
          "human_verification_lane": {
            "$ref": "./communities-core.yaml#/HumanVerificationLane"
          },
          "joinable_now": {
            "type": "boolean"
          },
          "status": {
            "type": "string",
            "enum": [
              "joinable",
              "requestable",
              "pending_request",
              "verification_required",
              "gate_failed",
              "already_joined",
              "banned"
            ]
          },
          "membership_gate_summaries": {
            "type": "array",
            "items": {
              "$ref": "./communities-core.yaml#/MembershipGateSummary"
            }
          },
          "missing_capabilities": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "unique_human",
                "age_over_18",
                "minimum_age",
                "nationality",
                "gender",
                "wallet_score"
              ]
            },
            "description": "Missing capability keys for the evaluated join path. Public-v0 community remediation should\nsurface only capability keys Pirate can remediate end to end for the current lane, including\n`unique_human`, `age_over_18`, `nationality`, and `gender` for Self-backed flows and\n`wallet_score` for Human Passport checks.\n"
          },
          "suggested_verification_provider": {
            "type": "string",
            "enum": [
              "self",
              "very",
              "passport"
            ],
            "nullable": true
          },
          "suggested_verification_intent": {
            "type": "string",
            "enum": [
              "community_join"
            ],
            "nullable": true
          },
          "failure_reason": {
            "type": "string",
            "enum": [
              "missing_verification",
              "provider_not_accepted",
              "nationality_mismatch",
              "gender_mismatch",
              "minimum_age_mismatch",
              "erc721_holding_required",
              "erc721_inventory_match_required",
              "token_inventory_unavailable",
              "wallet_score_too_low",
              "unsupported",
              "banned"
            ],
            "nullable": true
          },
          "wallet_score_status": {
            "type": "object",
            "nullable": true,
            "description": "Current authenticated user's Human Passport score state when the evaluated community\nincludes a wallet_score gate. Exposed only on user-specific eligibility/failure responses\nso clients can explain current-vs-required remediation without exposing stamp details.\n",
            "properties": {
              "current_score": {
                "type": "number",
                "nullable": true
              },
              "required_score": {
                "type": "number",
                "nullable": true
              },
              "passing_score": {
                "type": "boolean",
                "nullable": true
              },
              "last_score_timestamp": {
                "type": "string",
                "format": "date-time",
                "nullable": true
              }
            }
          }
        }
      },
      "MembershipRequestStatus": {
        "type": "string",
        "enum": [
          "pending",
          "approved",
          "rejected",
          "expired"
        ]
      },
      "MembershipRequestSummary": {
        "type": "object",
        "required": [
          "membership_request_id",
          "community_id",
          "applicant_user_id",
          "status",
          "created_at"
        ],
        "properties": {
          "membership_request_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "applicant_user_id": {
            "type": "string"
          },
          "applicant_handle": {
            "type": "string",
            "nullable": true
          },
          "applicant_avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "$ref": "./communities-core.yaml#/MembershipRequestStatus"
          },
          "note": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "MembershipRequestListResponse": {
        "type": "object",
        "required": [
          "items",
          "next_cursor"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./communities-core.yaml#/MembershipRequestSummary"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "GateFailureDetails": {
        "type": "object",
        "properties": {
          "human_verification_lane": {
            "$ref": "./communities-core.yaml#/HumanVerificationLane"
          },
          "membership_gate_summaries": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "./communities-core.yaml#/MembershipGateSummary"
            }
          },
          "missing_capabilities": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
          },
          "suggested_verification_provider": {
            "type": "string",
            "enum": [
              "self",
              "very",
              "passport"
            ],
            "nullable": true
          },
          "suggested_verification_intent": {
            "type": "string",
            "enum": [
              "community_join"
            ],
            "nullable": true
          },
          "failure_reason": {
            "type": "string",
            "enum": [
              "missing_verification",
              "provider_not_accepted",
              "nationality_mismatch",
              "gender_mismatch",
              "minimum_age_mismatch",
              "erc721_holding_required",
              "erc721_inventory_match_required",
              "token_inventory_unavailable",
              "wallet_score_too_low",
              "unsupported",
              "banned"
            ],
            "nullable": true
          },
          "wallet_score_status": {
            "type": "object",
            "nullable": true,
            "description": "Current authenticated user's Human Passport score state when a wallet_score gate blocked\na join attempt.\n",
            "properties": {
              "current_score": {
                "type": "number",
                "nullable": true
              },
              "required_score": {
                "type": "number",
                "nullable": true
              },
              "passing_score": {
                "type": "boolean",
                "nullable": true
              },
              "last_score_timestamp": {
                "type": "string",
                "format": "date-time",
                "nullable": true
              }
            }
          }
        }
      },
      "CommunityContentAuthenticityStance": {
        "type": "string",
        "enum": [
          "human_only",
          "human_first",
          "ai_allowed_with_disclosure",
          "ai_allowed"
        ]
      },
      "CommunityPolicyOrigin": {
        "type": "string",
        "enum": [
          "default",
          "explicit"
        ]
      },
      "CommunityPricingVerificationProvider": {
        "type": "string",
        "enum": [
          "self"
        ]
      },
      "CommunityPricingAdjustmentType": {
        "type": "string",
        "enum": [
          "multiplier"
        ]
      },
      "CommunityPricingTier": {
        "type": "object",
        "required": [
          "tier_key",
          "adjustment_type",
          "adjustment_value"
        ],
        "additionalProperties": false,
        "properties": {
          "tier_key": {
            "type": "string"
          },
          "display_name": {
            "type": "string",
            "nullable": true
          },
          "adjustment_type": {
            "$ref": "./communities-community.yaml#/CommunityPricingAdjustmentType"
          },
          "adjustment_value": {
            "type": "number",
            "minimum": 0
          }
        }
      },
      "CommunityPricingCountryAssignment": {
        "type": "object",
        "required": [
          "country_code",
          "tier_key"
        ],
        "additionalProperties": false,
        "properties": {
          "country_code": {
            "type": "string",
            "minLength": 2,
            "maxLength": 2,
            "description": "ISO 3166-1 alpha-2 country code used for nationality-backed pricing.\n"
          },
          "tier_key": {
            "type": "string"
          }
        }
      },
      "CreateCommunityPricingPolicyInput": {
        "type": "object",
        "description": "Optional community pricing policy supplied at creation time. This policy is distinct from the money policy: it controls buyer-visible USD quote adjustments, not allowed funding lanes or settlement rails. If omitted, the server must resolve the default non-tiered pricing posture with `policy_origin = default`.\n",
        "required": [
          "regional_pricing_enabled",
          "tiers",
          "country_assignments"
        ],
        "additionalProperties": false,
        "properties": {
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "verification_provider_requirement": {
            "$ref": "./communities-community.yaml#/CommunityPricingVerificationProvider",
            "nullable": true
          },
          "default_tier_key": {
            "type": "string",
            "nullable": true
          },
          "tiers": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityPricingTier"
            }
          },
          "country_assignments": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityPricingCountryAssignment"
            }
          },
          "source_template_id": {
            "type": "string",
            "nullable": true
          },
          "source_template_version": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "UpdateCommunityPricingPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community pricing policy. Changes apply prospectively to future quote generation only. Existing purchases remain pinned to the pricing tier and pricing-policy version captured in their quote and settlement snapshots.\n",
        "required": [
          "regional_pricing_enabled",
          "tiers",
          "country_assignments"
        ],
        "additionalProperties": false,
        "properties": {
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "verification_provider_requirement": {
            "$ref": "./communities-community.yaml#/CommunityPricingVerificationProvider",
            "nullable": true
          },
          "default_tier_key": {
            "type": "string",
            "nullable": true
          },
          "tiers": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityPricingTier"
            }
          },
          "country_assignments": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityPricingCountryAssignment"
            }
          },
          "source_template_id": {
            "type": "string",
            "nullable": true
          },
          "source_template_version": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CommunityPricingPolicy": {
        "type": "object",
        "description": "Resolved community pricing policy for commerce. This policy controls whether a listing that opts in may adjust the authored USD base price using buyer verification-backed tiering. It is separate from money policy, which controls allowed funding lanes and settlement constraints. When no explicit pricing policy has been configured, the server must still return the default non-tiered policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "pricing_policy_version",
          "regional_pricing_enabled",
          "tiers",
          "country_assignments",
          "updated_at"
        ],
        "additionalProperties": false,
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "pricing_policy_version": {
            "type": "string",
            "description": "Version identifier that the quote layer must snapshot whenever this policy affects price resolution.\n"
          },
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "verification_provider_requirement": {
            "$ref": "./communities-community.yaml#/CommunityPricingVerificationProvider",
            "nullable": true
          },
          "default_tier_key": {
            "type": "string",
            "nullable": true
          },
          "tiers": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityPricingTier"
            }
          },
          "country_assignments": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityPricingCountryAssignment"
            }
          },
          "source_template_id": {
            "type": "string",
            "nullable": true
          },
          "source_template_version": {
            "type": "string",
            "nullable": true
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityListing": {
        "type": "object",
        "required": [
          "listing_id",
          "community_id",
          "listing_mode",
          "status",
          "price_usd",
          "regional_pricing_enabled",
          "created_by_user_id",
          "created_at",
          "updated_at"
        ],
        "additionalProperties": false,
        "properties": {
          "listing_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "asset_id": {
            "type": "string",
            "nullable": true
          },
          "live_room_id": {
            "type": "string",
            "nullable": true
          },
          "listing_mode": {
            "type": "string",
            "enum": [
              "fixed_price"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "active",
              "paused",
              "archived"
            ]
          },
          "price_usd": {
            "type": "number",
            "minimum": 0
          },
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_share_pct": {
            "type": "number",
            "nullable": true
          },
          "created_by_user_id": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityListingRequest": {
        "type": "object",
        "required": [
          "price_usd",
          "regional_pricing_enabled",
          "status"
        ],
        "additionalProperties": false,
        "properties": {
          "asset_id": {
            "type": "string",
            "nullable": true
          },
          "live_room_id": {
            "type": "string",
            "nullable": true
          },
          "price_usd": {
            "type": "number",
            "minimum": 0
          },
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_share_pct": {
            "type": "number",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "active",
              "paused",
              "archived"
            ]
          }
        }
      },
      "UpdateCommunityListingRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "price_usd": {
            "type": "number",
            "minimum": 0
          },
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_share_pct": {
            "type": "number",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "active",
              "paused",
              "archived"
            ]
          }
        }
      },
      "CommunityListingListResponse": {
        "type": "object",
        "required": [
          "items"
        ],
        "additionalProperties": false,
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityListing"
            }
          }
        }
      },
      "CommunitySaleAllocationRecipientType": {
        "type": "string",
        "enum": [
          "creator",
          "charity",
          "community_treasury"
        ]
      },
      "CommunitySaleAllocationSettlementStrategy": {
        "type": "string",
        "enum": [
          "story_payout",
          "provider_payout",
          "treasury_payout"
        ]
      },
      "CommunitySaleAllocationStatus": {
        "type": "string",
        "enum": [
          "quoted",
          "pending",
          "confirmed",
          "failed"
        ]
      },
      "CommunitySaleAllocationSnapshot": {
        "type": "object",
        "description": "Immutable quote-time allocation snapshot for a priced sale. Settlement must consume this snapshot directly rather than recomputing money flow from the current listing or community state.\n",
        "required": [
          "recipient_type",
          "waterfall_position",
          "share_bps",
          "amount_usd",
          "settlement_strategy"
        ],
        "additionalProperties": false,
        "properties": {
          "recipient_type": {
            "$ref": "./communities-community.yaml#/CommunitySaleAllocationRecipientType"
          },
          "recipient_ref": {
            "type": "string",
            "nullable": true
          },
          "waterfall_position": {
            "type": "integer",
            "minimum": 0
          },
          "share_bps": {
            "type": "integer",
            "minimum": 0,
            "maximum": 10000
          },
          "amount_usd": {
            "type": "number",
            "minimum": 0
          },
          "settlement_strategy": {
            "$ref": "./communities-community.yaml#/CommunitySaleAllocationSettlementStrategy"
          }
        }
      },
      "CommunitySaleAllocationLeg": {
        "allOf": [
          {
            "$ref": "./communities-community.yaml#/CommunitySaleAllocationSnapshot"
          },
          {
            "type": "object",
            "required": [
              "status"
            ],
            "additionalProperties": false,
            "properties": {
              "status": {
                "$ref": "./communities-community.yaml#/CommunitySaleAllocationStatus"
              },
              "settlement_ref": {
                "type": "string",
                "nullable": true
              },
              "failure_reason": {
                "type": "string",
                "nullable": true
              }
            }
          }
        ]
      },
      "CommunityPurchase": {
        "type": "object",
        "required": [
          "purchase_id",
          "community_id",
          "listing_id",
          "buyer_user_id",
          "settlement_wallet_attachment_id",
          "purchase_price_usd",
          "settlement_mode",
          "settlement_chain",
          "settlement_token",
          "settlement_tx_ref",
          "allocations",
          "purchase_entitlement_id",
          "entitlement_kind",
          "entitlement_target_ref",
          "created_at"
        ],
        "additionalProperties": false,
        "properties": {
          "purchase_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "listing_id": {
            "type": "string"
          },
          "asset_id": {
            "type": "string",
            "nullable": true
          },
          "live_room_id": {
            "type": "string",
            "nullable": true
          },
          "buyer_user_id": {
            "type": "string"
          },
          "settlement_wallet_attachment_id": {
            "type": "string"
          },
          "purchase_price_usd": {
            "type": "number",
            "minimum": 0
          },
          "pricing_tier": {
            "type": "string",
            "nullable": true
          },
          "settlement_mode": {
            "$ref": "./communities-community.yaml#/CommunityPurchaseSettlementMode"
          },
          "settlement_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
          },
          "settlement_token": {
            "type": "string"
          },
          "settlement_tx_ref": {
            "type": "string"
          },
          "allocations": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunitySaleAllocationLeg"
            }
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_share_pct": {
            "type": "number",
            "nullable": true
          },
          "donation_amount_usd": {
            "type": "number",
            "nullable": true
          },
          "purchase_entitlement_id": {
            "type": "string"
          },
          "entitlement_kind": {
            "type": "string",
            "enum": [
              "asset_access",
              "live_room_access",
              "replay_access",
              "license"
            ]
          },
          "entitlement_target_ref": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityPurchaseListResponse": {
        "type": "object",
        "required": [
          "items"
        ],
        "additionalProperties": false,
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityPurchase"
            }
          }
        }
      },
      "CommunityPurchaseSettlementRequest": {
        "type": "object",
        "description": "Confirm successful settlement for an already-issued community purchase quote. The server must reload the stored quote by `community_id` and `quote_id`, verify the quote belongs to the authenticated buyer, ensure it is still active and unexpired, then create the canonical purchase row and entitlement snapshot before marking the quote consumed.\n",
        "required": [
          "quote_id",
          "settlement_wallet_attachment_id",
          "funding_tx_ref",
          "settlement_tx_ref"
        ],
        "additionalProperties": false,
        "properties": {
          "quote_id": {
            "type": "string"
          },
          "settlement_wallet_attachment_id": {
            "type": "string"
          },
          "funding_tx_ref": {
            "type": "string",
            "description": "Confirmed buyer funding transaction that delivered the quoted source funding asset to the checkout operator before Pirate executes downstream payout legs."
          },
          "settlement_tx_ref": {
            "type": "string"
          }
        }
      },
      "CommunityPurchaseSettlement": {
        "type": "object",
        "description": "Canonical app-level record returned after successful purchase settlement finalization. This response snapshots the consumed quote, settlement reference, and granted entitlement surface.\n",
        "required": [
          "purchase_id",
          "quote_id",
          "community_id",
          "listing_id",
          "buyer_user_id",
          "settlement_wallet_attachment_id",
          "purchase_price_usd",
          "settlement_mode",
          "settlement_chain",
          "settlement_chain_ref",
          "settlement_token",
          "settlement_tx_ref",
          "allocations",
          "entitlement_kind",
          "entitlement_target_ref",
          "purchase_entitlement_id",
          "settled_at"
        ],
        "additionalProperties": false,
        "properties": {
          "purchase_id": {
            "type": "string"
          },
          "quote_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "listing_id": {
            "type": "string"
          },
          "buyer_user_id": {
            "type": "string"
          },
          "asset_id": {
            "type": "string",
            "nullable": true
          },
          "live_room_id": {
            "type": "string",
            "nullable": true
          },
          "settlement_wallet_attachment_id": {
            "type": "string"
          },
          "purchase_price_usd": {
            "type": "number",
            "minimum": 0
          },
          "pricing_tier": {
            "type": "string",
            "nullable": true
          },
          "settlement_mode": {
            "$ref": "./communities-community.yaml#/CommunityPurchaseSettlementMode"
          },
          "settlement_chain": {
            "$ref": "./communities-community.yaml#/CommunityMoneyChainRef"
          },
          "settlement_chain_ref": {
            "type": "string"
          },
          "settlement_token": {
            "type": "string"
          },
          "settlement_tx_ref": {
            "type": "string"
          },
          "allocations": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunitySaleAllocationLeg"
            }
          },
          "donation_partner_id": {
            "type": "string",
            "nullable": true
          },
          "donation_share_pct": {
            "type": "number",
            "nullable": true
          },
          "donation_amount_usd": {
            "type": "number",
            "nullable": true
          },
          "entitlement_kind": {
            "type": "string",
            "enum": [
              "asset_access",
              "live_room_access"
            ]
          },
          "entitlement_target_ref": {
            "type": "string"
          },
          "purchase_entitlement_id": {
            "type": "string"
          },
          "settled_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityPurchaseSettlementFailureRequest": {
        "type": "object",
        "description": "Mark an active purchase quote as failed without finalizing a purchase. This is the operator-facing failure path for routed or direct settlement attempts that did not finalize successfully.\n",
        "required": [
          "quote_id"
        ],
        "additionalProperties": false,
        "properties": {
          "quote_id": {
            "type": "string"
          }
        }
      },
      "CommunityPurchaseSettlementFailure": {
        "type": "object",
        "required": [
          "quote_id",
          "community_id",
          "status",
          "expires_at"
        ],
        "additionalProperties": false,
        "properties": {
          "quote_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "failed",
              "expired"
            ]
          },
          "failed_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityModerationDecisionLevel": {
        "type": "string",
        "enum": [
          "allow",
          "review",
          "disallow"
        ]
      },
      "CommunityEscalationDecisionLevel": {
        "type": "string",
        "enum": [
          "review",
          "disallow"
        ]
      },
      "CommunityDisclosureDecisionLevel": {
        "type": "string",
        "enum": [
          "allow",
          "require_disclosure",
          "disallow"
        ]
      },
      "CommunitySelfPromotionMode": {
        "type": "string",
        "enum": [
          "disallow",
          "limited_with_disclosure",
          "allowed_with_participation",
          "creator_friendly"
        ]
      },
      "CommunityFalseClaimConsequence": {
        "type": "string",
        "enum": [
          "warning",
          "post_removed",
          "temporary_ban",
          "permanent_ban"
        ]
      },
      "CommunityCreatorRelation": {
        "type": "string",
        "description": "Community-local copy of the canonical creator-relation enum used by provenance policy. This should remain semantically aligned with `posts.yaml#/PostCreatorRelation` without creating a schema-level dependency from the community schema onto the post schema.\n",
        "enum": [
          "captured",
          "created",
          "subject",
          "authorized_repost",
          "fan_work",
          "found"
        ]
      },
      "CommunityContentAuthenticityDetectionSelectionMode": {
        "type": "string",
        "enum": [
          "platform_default",
          "approved_profile"
        ]
      },
      "CommunityAuthenticityDetectionProfileStatus": {
        "type": "string",
        "enum": [
          "active",
          "archived"
        ]
      },
      "CommunityAuthenticityDetectionProfileSummary": {
        "type": "object",
        "description": "Public/admin-safe summary of a platform-approved authenticity-detection profile. Communities choose from these platform-managed profiles rather than configuring raw provider parameters directly.\n",
        "required": [
          "authenticity_detection_profile_id",
          "profile_key",
          "provider_key",
          "supported_capabilities",
          "status"
        ],
        "properties": {
          "authenticity_detection_profile_id": {
            "type": "string"
          },
          "profile_key": {
            "type": "string"
          },
          "provider_key": {
            "type": "string",
            "description": "Provider implementation key such as `hive`, `truthscan`, or a future Pirate-managed detector.\n"
          },
          "supported_capabilities": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "image_authenticity",
                "video_authenticity",
                "audio_authenticity",
                "deepfake_detection"
              ]
            }
          },
          "status": {
            "$ref": "./communities-community.yaml#/CommunityAuthenticityDetectionProfileStatus"
          }
        }
      },
      "CommunityTextAuthenticityPolicySettings": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "allow_ai_assisted_editing",
          "allow_ai_generated"
        ],
        "properties": {
          "allow_ai_assisted_editing": {
            "type": "boolean"
          },
          "allow_ai_generated": {
            "type": "boolean"
          }
        }
      },
      "CommunityImageAuthenticityPolicySettings": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "allow_ai_upscale",
          "allow_ai_restoration",
          "allow_generative_editing",
          "allow_ai_generated"
        ],
        "properties": {
          "allow_ai_upscale": {
            "type": "boolean"
          },
          "allow_ai_restoration": {
            "type": "boolean"
          },
          "allow_generative_editing": {
            "type": "boolean"
          },
          "allow_ai_generated": {
            "type": "boolean"
          }
        }
      },
      "CommunityVideoAuthenticityPolicySettings": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "allow_ai_upscale",
          "allow_ai_restoration",
          "allow_ai_frame_interpolation",
          "allow_generative_editing",
          "allow_ai_generated"
        ],
        "properties": {
          "allow_ai_upscale": {
            "type": "boolean"
          },
          "allow_ai_restoration": {
            "type": "boolean"
          },
          "allow_ai_frame_interpolation": {
            "type": "boolean"
          },
          "allow_generative_editing": {
            "type": "boolean"
          },
          "allow_ai_generated": {
            "type": "boolean"
          }
        }
      },
      "CommunitySongAuthenticityPolicySettings": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "allow_ai_assisted_mastering",
          "allow_ai_stem_separation",
          "allow_ai_generated_instrumentals",
          "allow_ai_generated_lyrics",
          "allow_ai_generated_vocals"
        ],
        "properties": {
          "allow_ai_assisted_mastering": {
            "type": "boolean"
          },
          "allow_ai_stem_separation": {
            "type": "boolean"
          },
          "allow_ai_generated_instrumentals": {
            "type": "boolean"
          },
          "allow_ai_generated_lyrics": {
            "type": "boolean"
          },
          "allow_ai_generated_vocals": {
            "type": "boolean"
          }
        }
      },
      "CreateCommunityContentAuthenticityPolicyInput": {
        "type": "object",
        "description": "Structured community policy for AI-assisted and AI-generated content. Platform-level bans such as non-consensual sexual deepfakes or deceptive impersonation of real people are intentionally not represented here and must override any community setting.\n",
        "required": [
          "authenticity_stance",
          "text_policy",
          "image_policy",
          "video_policy",
          "song_policy"
        ],
        "additionalProperties": false,
        "properties": {
          "authenticity_stance": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityStance"
          },
          "text_policy": {
            "$ref": "./communities-community.yaml#/CommunityTextAuthenticityPolicySettings"
          },
          "image_policy": {
            "$ref": "./communities-community.yaml#/CommunityImageAuthenticityPolicySettings"
          },
          "video_policy": {
            "$ref": "./communities-community.yaml#/CommunityVideoAuthenticityPolicySettings"
          },
          "song_policy": {
            "$ref": "./communities-community.yaml#/CommunitySongAuthenticityPolicySettings"
          }
        }
      },
      "UpdateCommunityContentAuthenticityPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's structured authenticity policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "authenticity_stance",
          "text_policy",
          "image_policy",
          "video_policy",
          "song_policy"
        ],
        "additionalProperties": false,
        "properties": {
          "authenticity_stance": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityStance"
          },
          "text_policy": {
            "$ref": "./communities-community.yaml#/CommunityTextAuthenticityPolicySettings"
          },
          "image_policy": {
            "$ref": "./communities-community.yaml#/CommunityImageAuthenticityPolicySettings"
          },
          "video_policy": {
            "$ref": "./communities-community.yaml#/CommunityVideoAuthenticityPolicySettings"
          },
          "song_policy": {
            "$ref": "./communities-community.yaml#/CommunitySongAuthenticityPolicySettings"
          }
        }
      },
      "CommunityContentAuthenticityPolicy": {
        "type": "object",
        "description": "Resolved community authenticity policy. This setting is separate from freeform rules text and separate from rights or source authorization policy. When no explicit policy has been configured, the server must still return the restrictive default policy with `policy_origin = default`. In that case, `updated_at` may be synthesized from the applicable default-policy revision timestamp or another server-defined default-policy source.\n",
        "required": [
          "community_id",
          "policy_origin",
          "authenticity_stance",
          "text_policy",
          "image_policy",
          "video_policy",
          "song_policy",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "authenticity_stance": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityStance"
          },
          "text_policy": {
            "$ref": "./communities-community.yaml#/CommunityTextAuthenticityPolicySettings"
          },
          "image_policy": {
            "$ref": "./communities-community.yaml#/CommunityImageAuthenticityPolicySettings"
          },
          "video_policy": {
            "$ref": "./communities-community.yaml#/CommunityVideoAuthenticityPolicySettings"
          },
          "song_policy": {
            "$ref": "./communities-community.yaml#/CommunitySongAuthenticityPolicySettings"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityIdentifiedPersonMediaScope": {
        "type": "string",
        "enum": [
          "subject_only",
          "subject_or_authorized",
          "public_source_allowed"
        ]
      },
      "CreateCommunitySourcePolicyInput": {
        "type": "object",
        "description": "Structured community policy for reposts, source attribution, and human-made fan works involving identified real people. Synthetic likeness rules remain platform-level constraints and are intentionally not represented here.\n",
        "required": [
          "identified_person_media_scope",
          "require_source_url_for_reposts",
          "allow_human_made_fan_art_of_real_people",
          "require_fan_art_disclosure"
        ],
        "additionalProperties": false,
        "properties": {
          "identified_person_media_scope": {
            "$ref": "./communities-community.yaml#/CommunityIdentifiedPersonMediaScope"
          },
          "require_source_url_for_reposts": {
            "type": "boolean"
          },
          "allow_human_made_fan_art_of_real_people": {
            "type": "boolean"
          },
          "require_fan_art_disclosure": {
            "type": "boolean"
          }
        }
      },
      "UpdateCommunitySourcePolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's structured source policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "identified_person_media_scope",
          "require_source_url_for_reposts",
          "allow_human_made_fan_art_of_real_people",
          "require_fan_art_disclosure"
        ],
        "additionalProperties": false,
        "properties": {
          "identified_person_media_scope": {
            "$ref": "./communities-community.yaml#/CommunityIdentifiedPersonMediaScope"
          },
          "require_source_url_for_reposts": {
            "type": "boolean"
          },
          "allow_human_made_fan_art_of_real_people": {
            "type": "boolean"
          },
          "require_fan_art_disclosure": {
            "type": "boolean"
          }
        }
      },
      "CommunitySourcePolicy": {
        "type": "object",
        "description": "Resolved community source policy for reposts and fan works. This policy is orthogonal to AI authenticity settings and does not weaken platform-level bans on deceptive synthetic likeness content. When no explicit policy has been configured, the server must still return the restrictive default policy with `policy_origin = default`. In that case, `updated_at` may be synthesized from the applicable default-policy revision timestamp or another server-defined default-policy source.\n",
        "required": [
          "community_id",
          "policy_origin",
          "identified_person_media_scope",
          "require_source_url_for_reposts",
          "allow_human_made_fan_art_of_real_people",
          "require_fan_art_disclosure",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "identified_person_media_scope": {
            "$ref": "./communities-community.yaml#/CommunityIdentifiedPersonMediaScope"
          },
          "require_source_url_for_reposts": {
            "type": "boolean"
          },
          "allow_human_made_fan_art_of_real_people": {
            "type": "boolean"
          },
          "require_fan_art_disclosure": {
            "type": "boolean"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityCaptureEditPolicyInput": {
        "type": "object",
        "description": "Structured community policy for non-generative photo and video editing such as retouching or compositing. Generative and AI-specific rules remain part of `content_authenticity_policy`.\n",
        "required": [
          "basic_adjustments",
          "retouching",
          "compositing",
          "documentary_editing",
          "require_edit_disclosure"
        ],
        "additionalProperties": false,
        "properties": {
          "basic_adjustments": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "retouching": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "compositing": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "documentary_editing": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "require_edit_disclosure": {
            "type": "boolean"
          }
        }
      },
      "UpdateCommunityCaptureEditPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's structured non-generative edit policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "basic_adjustments",
          "retouching",
          "compositing",
          "documentary_editing",
          "require_edit_disclosure"
        ],
        "additionalProperties": false,
        "properties": {
          "basic_adjustments": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "retouching": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "compositing": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "documentary_editing": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "require_edit_disclosure": {
            "type": "boolean"
          }
        }
      },
      "CommunityCaptureEditPolicy": {
        "type": "object",
        "description": "Resolved community capture-edit policy for non-generative media adjustments. When no explicit policy has been configured, the server must still return the effective default policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "basic_adjustments",
          "retouching",
          "compositing",
          "documentary_editing",
          "require_edit_disclosure",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "basic_adjustments": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "retouching": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "compositing": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "documentary_editing": {
            "$ref": "./communities-community.yaml#/CommunityDisclosureDecisionLevel"
          },
          "require_edit_disclosure": {
            "type": "boolean"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityAdultContentPolicyInput": {
        "type": "object",
        "description": "Structured community policy for adult-content subcategories. Platform age-gating and safety scanning remain mandatory regardless of this policy.\n",
        "required": [
          "suggestive",
          "artistic_nudity",
          "explicit_nudity",
          "explicit_sexual_content",
          "fetish_content"
        ],
        "additionalProperties": false,
        "properties": {
          "suggestive": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "artistic_nudity": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "explicit_nudity": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "explicit_sexual_content": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "fetish_content": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          }
        }
      },
      "UpdateCommunityAdultContentPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's structured adult-content policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "suggestive",
          "artistic_nudity",
          "explicit_nudity",
          "explicit_sexual_content",
          "fetish_content"
        ],
        "additionalProperties": false,
        "properties": {
          "suggestive": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "artistic_nudity": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "explicit_nudity": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "explicit_sexual_content": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "fetish_content": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          }
        }
      },
      "CommunityAdultContentPolicy": {
        "type": "object",
        "description": "Resolved community adult-content policy. When no explicit policy has been configured, the server must still return the effective default policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "suggestive",
          "artistic_nudity",
          "explicit_nudity",
          "explicit_sexual_content",
          "fetish_content",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "suggestive": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "artistic_nudity": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "explicit_nudity": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "explicit_sexual_content": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "fetish_content": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityGraphicContentPolicyInput": {
        "type": "object",
        "description": "Structured community policy for graphic and disturbing content subcategories.\n",
        "required": [
          "injury_medical",
          "gore",
          "extreme_gore",
          "body_horror_disturbing",
          "animal_harm"
        ],
        "additionalProperties": false,
        "properties": {
          "injury_medical": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "gore": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "extreme_gore": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "body_horror_disturbing": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "animal_harm": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          }
        }
      },
      "UpdateCommunityGraphicContentPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's structured graphic-content policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "injury_medical",
          "gore",
          "extreme_gore",
          "body_horror_disturbing",
          "animal_harm"
        ],
        "additionalProperties": false,
        "properties": {
          "injury_medical": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "gore": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "extreme_gore": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "body_horror_disturbing": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "animal_harm": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          }
        }
      },
      "CommunityGraphicContentPolicy": {
        "type": "object",
        "description": "Resolved community graphic-content policy. When no explicit policy has been configured, the server must still return the effective default policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "injury_medical",
          "gore",
          "extreme_gore",
          "body_horror_disturbing",
          "animal_harm",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "injury_medical": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "gore": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "extreme_gore": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "body_horror_disturbing": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "animal_harm": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityMotionMediaPolicyInput": {
        "type": "object",
        "description": "Structured community policy for animated images, looping clips, and ordinary audio-bearing video. This policy intentionally does not create a separate `gif` post type.\n",
        "required": [
          "allow_animated_images",
          "allow_silent_looping_video",
          "allow_audio_video"
        ],
        "additionalProperties": false,
        "properties": {
          "allow_animated_images": {
            "type": "boolean"
          },
          "allow_silent_looping_video": {
            "type": "boolean"
          },
          "allow_audio_video": {
            "type": "boolean"
          },
          "max_video_duration_seconds": {
            "type": "integer",
            "nullable": true
          },
          "require_video_transcription": {
            "type": "boolean"
          }
        }
      },
      "UpdateCommunityMotionMediaPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's motion-media policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "allow_animated_images",
          "allow_silent_looping_video",
          "allow_audio_video"
        ],
        "additionalProperties": false,
        "properties": {
          "allow_animated_images": {
            "type": "boolean"
          },
          "allow_silent_looping_video": {
            "type": "boolean"
          },
          "allow_audio_video": {
            "type": "boolean"
          },
          "max_video_duration_seconds": {
            "type": "integer",
            "nullable": true
          },
          "require_video_transcription": {
            "type": "boolean"
          }
        }
      },
      "CommunityMotionMediaPolicy": {
        "type": "object",
        "description": "Resolved community motion-media policy. When no explicit policy has been configured, the server must still return the effective default policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "allow_animated_images",
          "allow_silent_looping_video",
          "allow_audio_video",
          "require_video_transcription",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "allow_animated_images": {
            "type": "boolean"
          },
          "allow_silent_looping_video": {
            "type": "boolean"
          },
          "allow_audio_video": {
            "type": "boolean"
          },
          "max_video_duration_seconds": {
            "type": "integer",
            "nullable": true
          },
          "require_video_transcription": {
            "type": "boolean"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityLanguagePolicyInput": {
        "type": "object",
        "description": "Structured community policy for ordinary profanity, slurs, and related language categories above the platform floor.\n",
        "required": [
          "profanity",
          "slurs"
        ],
        "additionalProperties": false,
        "properties": {
          "profanity": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "slurs": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          }
        }
      },
      "UpdateCommunityLanguagePolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's language policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "profanity",
          "slurs"
        ],
        "additionalProperties": false,
        "properties": {
          "profanity": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "slurs": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          }
        }
      },
      "CommunityLanguagePolicy": {
        "type": "object",
        "description": "Resolved community language policy. When no explicit policy has been configured, the server must still return the effective default policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "profanity",
          "slurs",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "profanity": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "slurs": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityCivilityPolicyInput": {
        "type": "object",
        "description": "Structured community policy for group-directed demeaning language, targeted insults, harassment, and related legal-but-disputed conduct categories above the platform floor.\n",
        "required": [
          "group_directed_demeaning_language",
          "targeted_insults",
          "targeted_harassment",
          "threatening_language"
        ],
        "additionalProperties": false,
        "properties": {
          "group_directed_demeaning_language": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "targeted_insults": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "targeted_harassment": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "threatening_language": {
            "$ref": "./communities-community.yaml#/CommunityEscalationDecisionLevel"
          }
        }
      },
      "UpdateCommunityCivilityPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's civility policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "group_directed_demeaning_language",
          "targeted_insults",
          "targeted_harassment",
          "threatening_language"
        ],
        "additionalProperties": false,
        "properties": {
          "group_directed_demeaning_language": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "targeted_insults": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "targeted_harassment": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "threatening_language": {
            "$ref": "./communities-community.yaml#/CommunityEscalationDecisionLevel"
          }
        }
      },
      "CommunityCivilityPolicy": {
        "type": "object",
        "description": "Resolved community civility policy. When no explicit policy has been configured, the server must still return the effective default policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "group_directed_demeaning_language",
          "targeted_insults",
          "targeted_harassment",
          "threatening_language",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "group_directed_demeaning_language": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "targeted_insults": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "targeted_harassment": {
            "$ref": "./communities-community.yaml#/CommunityModerationDecisionLevel"
          },
          "threatening_language": {
            "$ref": "./communities-community.yaml#/CommunityEscalationDecisionLevel"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityProvenancePolicyInput": {
        "type": "object",
        "description": "Structured community policy for creator-relation claims and false-claim-of-ownership enforcement. This policy complements `source_policy` rather than replacing it.\n",
        "required": [
          "allowed_creator_relations",
          "require_creator_relation",
          "false_claim_consequence",
          "allow_oc_claim",
          "require_proof_for_original"
        ],
        "additionalProperties": false,
        "properties": {
          "allowed_creator_relations": {
            "type": "array",
            "minItems": 1,
            "items": {
              "$ref": "./communities-community.yaml#/CommunityCreatorRelation"
            }
          },
          "require_creator_relation": {
            "type": "boolean"
          },
          "false_claim_consequence": {
            "$ref": "./communities-community.yaml#/CommunityFalseClaimConsequence"
          },
          "allow_oc_claim": {
            "type": "boolean"
          },
          "require_proof_for_original": {
            "type": "boolean"
          }
        }
      },
      "UpdateCommunityProvenancePolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's provenance policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "allowed_creator_relations",
          "require_creator_relation",
          "false_claim_consequence",
          "allow_oc_claim",
          "require_proof_for_original"
        ],
        "additionalProperties": false,
        "properties": {
          "allowed_creator_relations": {
            "type": "array",
            "minItems": 1,
            "items": {
              "$ref": "./communities-community.yaml#/CommunityCreatorRelation"
            }
          },
          "require_creator_relation": {
            "type": "boolean"
          },
          "false_claim_consequence": {
            "$ref": "./communities-community.yaml#/CommunityFalseClaimConsequence"
          },
          "allow_oc_claim": {
            "type": "boolean"
          },
          "require_proof_for_original": {
            "type": "boolean"
          }
        }
      },
      "CommunityProvenancePolicy": {
        "type": "object",
        "description": "Resolved community provenance policy. When no explicit policy has been configured, the server must still return the effective default policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "allowed_creator_relations",
          "require_creator_relation",
          "false_claim_consequence",
          "allow_oc_claim",
          "require_proof_for_original",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "allowed_creator_relations": {
            "type": "array",
            "minItems": 1,
            "items": {
              "$ref": "./communities-community.yaml#/CommunityCreatorRelation"
            }
          },
          "require_creator_relation": {
            "type": "boolean"
          },
          "false_claim_consequence": {
            "$ref": "./communities-community.yaml#/CommunityFalseClaimConsequence"
          },
          "allow_oc_claim": {
            "type": "boolean"
          },
          "require_proof_for_original": {
            "type": "boolean"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityPromotionPolicyInput": {
        "type": "object",
        "description": "Structured community policy for self-promotion, affiliation disclosure, and participation-ratio enforcement.\n",
        "required": [
          "self_promotion_mode",
          "require_affiliation_disclosure"
        ],
        "additionalProperties": false,
        "properties": {
          "self_promotion_mode": {
            "$ref": "./communities-community.yaml#/CommunitySelfPromotionMode"
          },
          "require_affiliation_disclosure": {
            "type": "boolean"
          },
          "max_promotional_posts_per_week": {
            "type": "integer",
            "nullable": true,
            "description": "Rolling 7 * 24-hour cap for promotional posts.\n"
          },
          "promotional_participation_ratio": {
            "type": "number",
            "nullable": true
          },
          "require_minimum_membership_days": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "UpdateCommunityPromotionPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's promotion policy. Changes apply prospectively to future posts and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "self_promotion_mode",
          "require_affiliation_disclosure"
        ],
        "additionalProperties": false,
        "properties": {
          "self_promotion_mode": {
            "$ref": "./communities-community.yaml#/CommunitySelfPromotionMode"
          },
          "require_affiliation_disclosure": {
            "type": "boolean"
          },
          "max_promotional_posts_per_week": {
            "type": "integer",
            "nullable": true,
            "description": "Rolling 7 * 24-hour cap for promotional posts.\n"
          },
          "promotional_participation_ratio": {
            "type": "number",
            "nullable": true
          },
          "require_minimum_membership_days": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "CommunityPromotionPolicy": {
        "type": "object",
        "description": "Resolved community promotion policy. When no explicit policy has been configured, the server must still return the effective default policy with `policy_origin = default`.\n",
        "required": [
          "community_id",
          "policy_origin",
          "self_promotion_mode",
          "require_affiliation_disclosure",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "self_promotion_mode": {
            "$ref": "./communities-community.yaml#/CommunitySelfPromotionMode"
          },
          "require_affiliation_disclosure": {
            "type": "boolean"
          },
          "max_promotional_posts_per_week": {
            "type": "integer",
            "nullable": true,
            "description": "Effective rolling 7 * 24-hour cap for promotional posts.\n"
          },
          "promotional_participation_ratio": {
            "type": "number",
            "nullable": true
          },
          "require_minimum_membership_days": {
            "type": "integer",
            "nullable": true
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommunityContentAuthenticityDetectionPolicyInput": {
        "type": "object",
        "description": "Structured community setting for selecting which platform-approved authenticity-detection profile Pirate should use for community-optional authenticity decisions. Platform-required safety and age-gating analysis remain outside this setting and are never community-configurable.\n",
        "required": [
          "selection_mode"
        ],
        "additionalProperties": false,
        "properties": {
          "selection_mode": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityDetectionSelectionMode"
          },
          "authenticity_detection_profile_id": {
            "type": "string",
            "nullable": true,
            "description": "Required when `selection_mode = approved_profile`. Must reference an active platform-approved authenticity-detection profile.\n"
          }
        }
      },
      "UpdateCommunityContentAuthenticityDetectionPolicyRequest": {
        "type": "object",
        "description": "Replace or update the community's authenticity-detection selection. Changes apply prospectively to future authenticity analysis and moderation decisions; existing posts are not automatically reclassified.\n",
        "required": [
          "selection_mode"
        ],
        "additionalProperties": false,
        "properties": {
          "selection_mode": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityDetectionSelectionMode"
          },
          "authenticity_detection_profile_id": {
            "type": "string",
            "nullable": true,
            "description": "Required when `selection_mode = approved_profile`. Must reference an active platform-approved authenticity-detection profile.\n"
          }
        }
      },
      "CommunityContentAuthenticityDetectionPolicy": {
        "type": "object",
        "description": "Resolved community authenticity-detection policy. When no explicit selection has been configured, the server must still return the platform-default detection profile with `policy_origin = default`. The platform-default authenticity-detection profile is an operational invariant and must always exist while this feature is enabled. In that case, `updated_at` may be synthesized from the active platform-default profile version timestamp or another server-defined default-policy source.\n",
        "required": [
          "community_id",
          "policy_origin",
          "selection_mode",
          "resolved_profile",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "selection_mode": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityDetectionSelectionMode"
          },
          "resolved_profile": {
            "$ref": "./communities-community.yaml#/CommunityAuthenticityDetectionProfileSummary"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityReferenceLinkPlatform": {
        "type": "string",
        "enum": [
          "musicbrainz",
          "genius",
          "spotify",
          "apple_music",
          "wikipedia",
          "instagram",
          "tiktok",
          "x",
          "official_website",
          "youtube",
          "bandcamp",
          "soundcloud",
          "other"
        ]
      },
      "CommunityReferenceLinkStatus": {
        "type": "string",
        "enum": [
          "active",
          "archived"
        ]
      },
      "CommunityReferenceLinkVerificationApplicability": {
        "type": "string",
        "enum": [
          "eligible",
          "not_applicable"
        ]
      },
      "CommunityReferenceLinkVerificationState": {
        "type": "string",
        "enum": [
          "unverified",
          "pending",
          "verified",
          "rejected",
          "revoked"
        ]
      },
      "CommunityReferenceLinkVerificationMethod": {
        "type": "string",
        "enum": [
          "bio_code",
          "dns_txt",
          "website_meta",
          "website_file",
          "manual_review"
        ]
      },
      "CommunityReferenceLinkMetadata": {
        "type": "object",
        "description": "Public/admin-safe metadata for rendering a club reference link. `display_name` and `image_url` are the only recommended cross-platform keys in v0; other keys may be platform-specific.\n",
        "properties": {
          "display_name": {
            "type": "string",
            "nullable": true
          },
          "image_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          }
        },
        "additionalProperties": true
      },
      "CreateCommunityReferenceLinkRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "platform",
          "url"
        ],
        "properties": {
          "platform": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkPlatform"
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "label": {
            "type": "string",
            "nullable": true
          },
          "position": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          }
        }
      },
      "UpdateCommunityReferenceLinkRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "platform": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkPlatform"
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "label": {
            "type": "string",
            "nullable": true
          },
          "position": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          }
        }
      },
      "CommunityReferenceLinkPublic": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_reference_link_id",
          "platform",
          "url",
          "link_status",
          "verified",
          "metadata",
          "position"
        ],
        "properties": {
          "community_reference_link_id": {
            "type": "string"
          },
          "platform": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkPlatform"
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "external_id": {
            "type": "string",
            "nullable": true
          },
          "label": {
            "type": "string",
            "nullable": true
          },
          "link_status": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkStatus"
          },
          "verified": {
            "type": "boolean",
            "description": "Public-safe verification flag. This is true only when the current link state is `verified`; pending, rejected, revoked, and non-applicable states should all surface as `false` to public callers.\n"
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "metadata": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkMetadata"
          },
          "position": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "CommunityReferenceLinkAdmin": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_reference_link_id",
          "community_id",
          "platform",
          "url",
          "normalized_url",
          "link_status",
          "verification_applicability",
          "metadata",
          "position",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "community_reference_link_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "platform": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkPlatform"
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "normalized_url": {
            "type": "string",
            "format": "uri"
          },
          "external_id": {
            "type": "string",
            "nullable": true
          },
          "label": {
            "type": "string",
            "nullable": true
          },
          "link_status": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkStatus"
          },
          "verification_applicability": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkVerificationApplicability"
          },
          "verification_state": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CommunityReferenceLinkVerificationState"
              }
            ],
            "nullable": true
          },
          "verification_method": {
            "allOf": [
              {
                "$ref": "./communities-community.yaml#/CommunityReferenceLinkVerificationMethod"
              }
            ],
            "nullable": true
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "last_verification_checked_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "active_proof_id": {
            "type": "string",
            "nullable": true,
            "description": "Proof record that currently backs the link's `verified` state. This must be null whenever the link is not currently `verified`, including after a revoke transition.\n"
          },
          "metadata": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkMetadata"
          },
          "position": {
            "type": "integer",
            "minimum": 0
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityReferenceLinkReadResponse": {
        "oneOf": [
          {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkPublic"
          },
          {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkAdmin"
          }
        ]
      },
      "CommunityReferenceLinkPublicListResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityReferenceLinkPublic"
            }
          }
        }
      },
      "CommunityReferenceLinkAdminListResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityReferenceLinkAdmin"
            }
          }
        }
      },
      "CommunityReferenceLinkListResponse": {
        "oneOf": [
          {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkPublicListResponse"
          },
          {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkAdminListResponse"
          }
        ]
      },
      "VerifyCommunityReferenceLinkRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "verification_method"
        ],
        "properties": {
          "verification_method": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkVerificationMethod"
          },
          "force": {
            "type": "boolean",
            "default": false
          }
        }
      },
      "ReviewCommunityReferenceLinkProofRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "decision"
        ],
        "properties": {
          "decision": {
            "type": "string",
            "enum": [
              "accept",
              "reject"
            ]
          },
          "review_notes": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "RevokeCommunityReferenceLinkRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "reason": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CommunityReferenceLinkProof": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "proof_id",
          "community_reference_link_id",
          "community_id",
          "proof_type",
          "proof_target",
          "status",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "proof_id": {
            "type": "string"
          },
          "community_reference_link_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "proof_type": {
            "$ref": "./communities-community.yaml#/CommunityReferenceLinkVerificationMethod"
          },
          "proof_target": {
            "type": "string"
          },
          "challenge_code": {
            "type": "string",
            "nullable": true,
            "description": "Required for challenge-based proofs such as `bio_code`, `dns_txt`, `website_meta`, and `website_file`. Nullable only for non-challenge flows such as `manual_review`.\n"
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "pending",
              "accepted",
              "rejected",
              "revoked",
              "expired"
            ]
          },
          "evidence_ref": {
            "type": "string",
            "nullable": true
          },
          "review_notes": {
            "type": "string",
            "nullable": true
          },
          "verified_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "reviewed_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityReferenceLinkProofListResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/CommunityReferenceLinkProof"
            }
          }
        }
      },
      "UpdateCommunityDonationPolicyPublicRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "donation_policy"
        ],
        "properties": {
          "donation_policy": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "donation_policy_mode",
              "donation_partner_status"
            ],
            "properties": {
              "donation_policy_mode": {
                "type": "string",
                "enum": [
                  "none",
                  "optional_creator_sidecar"
                ]
              },
              "donation_partner_status": {
                "type": "string",
                "enum": [
                  "unconfigured",
                  "active",
                  "paused"
                ]
              }
            }
          }
        }
      },
      "CommunityDonationPolicyPublicMutationResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_id",
          "donation_policy"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "donation_policy": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "donation_policy_mode",
              "donation_partner_status"
            ],
            "properties": {
              "donation_policy_mode": {
                "type": "string",
                "enum": [
                  "none",
                  "optional_creator_sidecar"
                ]
              },
              "donation_partner_status": {
                "type": "string",
                "enum": [
                  "unconfigured",
                  "active",
                  "paused"
                ]
              }
            }
          }
        }
      },
      "StructuredAccessLink": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "href",
          "type"
        ],
        "properties": {
          "href": {
            "type": "string"
          },
          "type": {
            "type": "string",
            "enum": [
              "application/json",
              "text/html",
              "text/markdown"
            ]
          },
          "auth_required": {
            "type": "boolean",
            "default": false
          }
        }
      },
      "StructuredAccessLinks": {
        "type": "object",
        "additionalProperties": {
          "$ref": "./communities-community.yaml#/StructuredAccessLink"
        },
        "description": "Typed traversal links for structured community responses. Clients should follow links instead of constructing Pirate URL templates from IDs.\n"
      },
      "OmittedStructuredSurface": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "surface",
          "reason"
        ],
        "properties": {
          "surface": {
            "type": "string",
            "enum": [
              "community_stats",
              "thread_cards",
              "thread_bodies",
              "top_comments",
              "events"
            ]
          },
          "reason": {
            "type": "string",
            "description": "Versioned reason string. Current values include `community_opt_out`, `platform_disabled`, `not_visible`, and `not_in_v0`; clients must treat unknown values as non-fatal unavailable-surface explanations.\n",
            "enum": [
              "community_opt_out",
              "platform_disabled",
              "not_visible",
              "not_in_v0"
            ]
          }
        }
      },
      "CommunityMachineAccessIncludedSurfaces": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_identity",
          "community_stats",
          "thread_cards",
          "thread_bodies",
          "top_comments",
          "events"
        ],
        "properties": {
          "community_identity": {
            "type": "boolean",
            "enum": [
              true
            ]
          },
          "community_stats": {
            "type": "boolean"
          },
          "thread_cards": {
            "type": "boolean"
          },
          "thread_bodies": {
            "type": "boolean"
          },
          "top_comments": {
            "type": "boolean"
          },
          "events": {
            "type": "boolean"
          }
        }
      },
      "CommunityMachineAccessAllowedUses": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "summarization",
          "analytics",
          "ai_training"
        ],
        "properties": {
          "summarization": {
            "type": "boolean",
            "enum": [
              true
            ]
          },
          "analytics": {
            "type": "boolean",
            "enum": [
              true
            ]
          },
          "ai_training": {
            "type": "string",
            "enum": [
              "prohibited"
            ]
          }
        }
      },
      "CommunityMachineAccessOperationalLimits": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "anonymous_rate_tier",
          "authenticated_rate_tier",
          "top_comments_limit",
          "max_lookback_window"
        ],
        "properties": {
          "anonymous_rate_tier": {
            "type": "string",
            "enum": [
              "low"
            ]
          },
          "authenticated_rate_tier": {
            "type": "string",
            "enum": [
              "standard"
            ]
          },
          "top_comments_limit": {
            "type": "integer",
            "minimum": 0
          },
          "max_lookback_window": {
            "type": "string"
          }
        }
      },
      "CommunityMachineAccessPolicy": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_id",
          "policy_origin",
          "access_mode",
          "included_surfaces",
          "allowed_uses",
          "operational_limits",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "policy_origin": {
            "type": "string",
            "enum": [
              "default",
              "explicit"
            ]
          },
          "access_mode": {
            "type": "string",
            "enum": [
              "structured_api",
              "structured_api_enhanced"
            ],
            "description": "`structured_api_enhanced` is reserved for later operational tiers and is not a paid v0 mode.\n"
          },
          "included_surfaces": {
            "$ref": "./communities-community.yaml#/CommunityMachineAccessIncludedSurfaces"
          },
          "allowed_uses": {
            "$ref": "./communities-community.yaml#/CommunityMachineAccessAllowedUses"
          },
          "operational_limits": {
            "$ref": "./communities-community.yaml#/CommunityMachineAccessOperationalLimits"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommunityMachineAccessPolicyPatch": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "access_mode": {
            "type": "string",
            "enum": [
              "structured_api",
              "structured_api_enhanced"
            ]
          },
          "included_surfaces": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "community_stats": {
                "type": "boolean"
              },
              "thread_cards": {
                "type": "boolean"
              },
              "thread_bodies": {
                "type": "boolean"
              },
              "top_comments": {
                "type": "boolean"
              },
              "events": {
                "type": "boolean"
              }
            }
          }
        }
      },
      "PublicCommunityIdentity": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_id",
          "slug",
          "name"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "slug": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "join_requirements": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "created_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "PublicCommunityStats": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "member_count": {
            "type": "integer",
            "minimum": 0
          },
          "post_count": {
            "type": "integer",
            "minimum": 0
          },
          "recent_activity": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "StructuredPublicCommunityResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community",
          "omitted_surfaces",
          "links"
        ],
        "properties": {
          "community": {
            "$ref": "./communities-community.yaml#/PublicCommunityIdentity"
          },
          "stats": {
            "$ref": "./communities-community.yaml#/PublicCommunityStats"
          },
          "omitted_surfaces": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/OmittedStructuredSurface"
            }
          },
          "links": {
            "$ref": "./communities-community.yaml#/StructuredAccessLinks"
          }
        }
      },
      "StructuredPostCard": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "post_id",
          "community_id",
          "title",
          "created_at",
          "reply_count",
          "links"
        ],
        "properties": {
          "post_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "author_handle": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "vote_count": {
            "type": "integer",
            "nullable": true
          },
          "reply_count": {
            "type": "integer",
            "minimum": 0
          },
          "body": {
            "type": "string",
            "nullable": true,
            "description": "Present only when `thread_bodies` is included."
          },
          "media": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": true
            }
          },
          "links": {
            "$ref": "./communities-community.yaml#/StructuredAccessLinks"
          }
        }
      },
      "StructuredPublicPostListResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items",
          "omitted_surfaces",
          "links"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/StructuredPostCard"
            }
          },
          "omitted_surfaces": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/OmittedStructuredSurface"
            }
          },
          "links": {
            "$ref": "./communities-community.yaml#/StructuredAccessLinks"
          }
        }
      },
      "StructuredPublicPostResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "post",
          "omitted_surfaces",
          "links"
        ],
        "properties": {
          "post": {
            "$ref": "./communities-community.yaml#/StructuredPostCard"
          },
          "omitted_surfaces": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/OmittedStructuredSurface"
            }
          },
          "links": {
            "$ref": "./communities-community.yaml#/StructuredAccessLinks"
          }
        }
      },
      "StructuredTopCommentsResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items",
          "top_comments_limit",
          "links"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./comments.yaml#/CommentListItem"
            }
          },
          "top_comments_limit": {
            "type": "integer",
            "minimum": 0
          },
          "links": {
            "$ref": "./communities-community.yaml#/StructuredAccessLinks"
          }
        }
      },
      "StructuredEventCard": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "event_id",
          "community_id",
          "title",
          "status",
          "links"
        ],
        "properties": {
          "event_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "host": {
            "type": "string",
            "nullable": true
          },
          "starts_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "status": {
            "type": "string"
          },
          "links": {
            "$ref": "./communities-community.yaml#/StructuredAccessLinks"
          }
        }
      },
      "StructuredPublicEventsResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items",
          "omitted_surfaces",
          "links"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/StructuredEventCard"
            }
          },
          "omitted_surfaces": {
            "type": "array",
            "items": {
              "$ref": "./communities-community.yaml#/OmittedStructuredSurface"
            }
          },
          "links": {
            "$ref": "./communities-community.yaml#/StructuredAccessLinks"
          }
        }
      },
      "Comment": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "comment_id",
          "community_id",
          "thread_root_post_id",
          "parent_comment_id",
          "author_user_id",
          "authorship_mode",
          "identity_mode",
          "anonymous_scope",
          "anonymous_label",
          "body",
          "status",
          "depth",
          "direct_reply_count",
          "descendant_count",
          "upvote_count",
          "downvote_count",
          "score",
          "last_reply_at",
          "content_hash",
          "swarm_body_ref",
          "idempotency_key",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "comment_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "thread_root_post_id": {
            "type": "string"
          },
          "parent_comment_id": {
            "type": "string",
            "nullable": true
          },
          "author_user_id": {
            "type": "string",
            "nullable": true
          },
          "authorship_mode": {
            "type": "string",
            "enum": [
              "human_direct",
              "user_agent"
            ]
          },
          "agent_id": {
            "type": "string",
            "nullable": true
          },
          "agent_ownership_record_id": {
            "type": "string",
            "nullable": true
          },
          "identity_mode": {
            "type": "string",
            "enum": [
              "public",
              "anonymous"
            ]
          },
          "anonymous_scope": {
            "type": "string",
            "enum": [
              "community_stable",
              "thread_stable"
            ],
            "nullable": true
          },
          "anonymous_label": {
            "type": "string",
            "nullable": true
          },
          "agent_handle_snapshot": {
            "type": "string",
            "nullable": true
          },
          "agent_display_name_snapshot": {
            "type": "string",
            "nullable": true
          },
          "agent_owner_handle_snapshot": {
            "type": "string",
            "nullable": true
          },
          "agent_ownership_provider_snapshot": {
            "$ref": "./agents.yaml#/AgentOwnershipProvider",
            "nullable": true
          },
          "body": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "published",
              "hidden",
              "removed",
              "deleted"
            ]
          },
          "depth": {
            "type": "integer"
          },
          "direct_reply_count": {
            "type": "integer"
          },
          "descendant_count": {
            "type": "integer"
          },
          "upvote_count": {
            "type": "integer"
          },
          "downvote_count": {
            "type": "integer"
          },
          "score": {
            "type": "integer"
          },
          "last_reply_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          },
          "swarm_body_ref": {
            "type": "string",
            "nullable": true
          },
          "idempotency_key": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CreateCommentRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "body"
        ],
        "properties": {
          "idempotency_key": {
            "type": "string",
            "nullable": true,
            "description": "Optional client-supplied idempotency key. Reusing the same key for the same author\nand community returns the already-created comment.\n"
          },
          "body": {
            "type": "string"
          },
          "authorship_mode": {
            "type": "string",
            "enum": [
              "human_direct",
              "user_agent"
            ],
            "default": "human_direct"
          },
          "agent_id": {
            "type": "string",
            "nullable": true,
            "description": "Required when `authorship_mode = user_agent`. Must be null when `authorship_mode = human_direct`.\n"
          },
          "agent_action_proof": {
            "$ref": "./agents.yaml#/AgentActionProof",
            "nullable": true,
            "description": "Required when `authorship_mode = user_agent`. For canonical request hashing, public v0\nexcludes this field itself from the canonical request body so the request does not\nrecursively sign its own proof envelope.\n"
          },
          "identity_mode": {
            "type": "string",
            "enum": [
              "public",
              "anonymous"
            ],
            "default": "public"
          },
          "anonymous_scope": {
            "type": "string",
            "enum": [
              "community_stable",
              "thread_stable"
            ],
            "nullable": true
          }
        }
      },
      "CommentListItem": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "comment",
          "viewer_vote",
          "resolved_locale",
          "translation_state",
          "machine_translated",
          "source_hash"
        ],
        "properties": {
          "comment": {
            "$ref": "./comments.yaml#/Comment"
          },
          "viewer_vote": {
            "type": "integer",
            "enum": [
              -1,
              1
            ],
            "nullable": true
          },
          "resolved_locale": {
            "type": "string"
          },
          "translation_state": {
            "type": "string",
            "enum": [
              "ready",
              "pending",
              "same_language",
              "policy_blocked"
            ]
          },
          "machine_translated": {
            "type": "boolean"
          },
          "translated_body": {
            "type": "string",
            "nullable": true
          },
          "source_hash": {
            "type": "string"
          }
        }
      },
      "CommentListResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items",
          "next_cursor",
          "thread_snapshot"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "./comments.yaml#/CommentListItem"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          },
          "thread_snapshot": {
            "$ref": "./comments.yaml#/CommentThreadSnapshot",
            "nullable": true
          }
        }
      },
      "CommentContext": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ancestors",
          "comment",
          "replies",
          "next_replies_cursor",
          "thread_snapshot"
        ],
        "properties": {
          "ancestors": {
            "type": "array",
            "items": {
              "$ref": "./comments.yaml#/CommentListItem"
            }
          },
          "comment": {
            "$ref": "./comments.yaml#/CommentListItem"
          },
          "replies": {
            "type": "array",
            "items": {
              "$ref": "./comments.yaml#/CommentListItem"
            }
          },
          "next_replies_cursor": {
            "type": "string",
            "nullable": true
          },
          "thread_snapshot": {
            "$ref": "./comments.yaml#/CommentThreadSnapshot",
            "nullable": true
          }
        }
      },
      "CommentThreadSnapshot": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "thread_root_post_id",
          "snapshot_seq",
          "published_through_comment_created_at",
          "comment_count",
          "swarm_manifest_ref",
          "swarm_feed_ref",
          "created_at"
        ],
        "properties": {
          "thread_root_post_id": {
            "type": "string"
          },
          "snapshot_seq": {
            "type": "integer"
          },
          "published_through_comment_created_at": {
            "type": "string",
            "format": "date-time"
          },
          "comment_count": {
            "type": "integer"
          },
          "swarm_manifest_ref": {
            "type": "string"
          },
          "swarm_feed_ref": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "CommentVoteResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "comment_id",
          "value"
        ],
        "properties": {
          "comment_id": {
            "type": "string"
          },
          "value": {
            "type": "integer",
            "enum": [
              -1,
              1
            ]
          }
        }
      },
      "AgentApiCatalog": {
        "type": "object",
        "additionalProperties": true,
        "description": "Top-level machine-readable API catalog. The exact linkset shape may evolve, but entries must identify href, media type, and auth requirements where applicable.\n",
        "required": [
          "links"
        ],
        "properties": {
          "links": {
            "type": "array",
            "items": {
              "$ref": "./agent-discovery.yaml#/AgentApiCatalogLink"
            }
          }
        }
      },
      "AgentApiCatalogLink": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "href",
          "rel",
          "type"
        ],
        "properties": {
          "href": {
            "type": "string"
          },
          "rel": {
            "type": "string"
          },
          "type": {
            "type": "string"
          },
          "title": {
            "type": "string",
            "nullable": true
          },
          "auth_required": {
            "type": "boolean",
            "default": false
          }
        }
      },
      "AgentSkillIndex": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "skills"
        ],
        "properties": {
          "skills": {
            "type": "array",
            "items": {
              "$ref": "./agent-discovery.yaml#/AgentSkill"
            }
          }
        }
      },
      "AgentSkill": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "title",
          "description",
          "links"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "auth_required": {
            "type": "boolean",
            "default": false
          },
          "links": {
            "type": "array",
            "items": {
              "$ref": "./agent-discovery.yaml#/AgentApiCatalogLink"
            }
          }
        }
      },
      "McpServerCard": {
        "type": "object",
        "additionalProperties": true,
        "description": "MCP Server Card discovery document. Pirate treats this as discovery metadata for an optional MCP wrapper over the structured HTTP read layer.\n",
        "required": [
          "version",
          "protocolVersion",
          "serverInfo",
          "transport",
          "capabilities"
        ],
        "properties": {
          "version": {
            "type": "string"
          },
          "protocolVersion": {
            "type": "string"
          },
          "serverInfo": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "name",
              "version"
            ],
            "properties": {
              "name": {
                "type": "string"
              },
              "title": {
                "type": "string"
              },
              "version": {
                "type": "string"
              }
            }
          },
          "description": {
            "type": "string"
          },
          "transport": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "type",
              "endpoint"
            ],
            "properties": {
              "type": {
                "type": "string"
              },
              "endpoint": {
                "type": "string"
              }
            }
          },
          "capabilities": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "WellKnownMetadata": {
        "type": "object",
        "additionalProperties": true,
        "description": "Generic well-known metadata document for OAuth, OIDC, and protected-resource discovery."
      },
      "PublicProfileResolution": {
        "type": "object",
        "required": [
          "profile",
          "requested_handle_label",
          "resolved_handle_label",
          "is_canonical",
          "created_communities"
        ],
        "properties": {
          "profile": {
            "$ref": "./profiles.yaml#/Profile"
          },
          "requested_handle_label": {
            "type": "string"
          },
          "resolved_handle_label": {
            "type": "string"
          },
          "is_canonical": {
            "type": "boolean"
          },
          "created_communities": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "community_id",
                "display_name",
                "created_at"
              ],
              "properties": {
                "community_id": {
                  "type": "string"
                },
                "display_name": {
                  "type": "string"
                },
                "route_slug": {
                  "type": "string",
                  "nullable": true
                },
                "created_at": {
                  "type": "string",
                  "format": "date-time"
                }
              }
            }
          }
        }
      },
      "LinkedHandle": {
        "type": "object",
        "required": [
          "linked_handle_id",
          "label",
          "kind",
          "verification_state"
        ],
        "properties": {
          "linked_handle_id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "pirate",
              "ens"
            ]
          },
          "verification_state": {
            "type": "string",
            "enum": [
              "verified",
              "unverified",
              "stale"
            ]
          },
          "metadata": {
            "type": "object",
            "additionalProperties": true,
            "nullable": true
          }
        }
      },
      "SongArtifactUploadRef": {
        "type": "object",
        "description": "Reference to a previously created and uploaded song artifact. The server resolves the\n`song_artifact_upload_id` into the corresponding `storage_ref`, `mime_type`, and other\nmetadata from the completed upload. The referenced upload must belong to the same community\nand uploader, and its `status` must be `uploaded`.\n",
        "required": [
          "song_artifact_upload_id"
        ],
        "additionalProperties": false,
        "properties": {
          "song_artifact_upload_id": {
            "type": "string"
          }
        }
      },
      "SongPreviewWindow": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "start_ms",
          "duration_ms"
        ],
        "properties": {
          "start_ms": {
            "type": "integer",
            "minimum": 0
          },
          "duration_ms": {
            "type": "integer",
            "minimum": 1
          }
        }
      },
      "SongPreviewGeneratePayload": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "song_artifact_bundle_id": {
            "type": "string",
            "nullable": true
          },
          "primary_audio_content_hash": {
            "type": "string",
            "nullable": true
          },
          "preview_window": {
            "$ref": "./song-artifacts.yaml#/SongPreviewWindow",
            "nullable": true
          }
        }
      },
      "Asset": {
        "type": "object",
        "required": [
          "asset_id",
          "community_id",
          "source_post_id",
          "creator_user_id",
          "asset_kind",
          "rights_basis",
          "access_mode",
          "primary_content_ref",
          "publication_status",
          "story_status",
          "locked_delivery_status",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "asset_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "source_post_id": {
            "type": "string"
          },
          "song_artifact_bundle_id": {
            "type": "string",
            "nullable": true
          },
          "display_title": {
            "type": "string",
            "nullable": true
          },
          "creator_user_id": {
            "type": "string"
          },
          "asset_kind": {
            "type": "string",
            "enum": [
              "song_audio",
              "video_file"
            ]
          },
          "rights_basis": {
            "type": "string",
            "enum": [
              "none",
              "original",
              "derivative",
              "attribution_only"
            ]
          },
          "access_mode": {
            "type": "string",
            "enum": [
              "public",
              "locked"
            ]
          },
          "license_preset": {
            "type": "string",
            "nullable": true,
            "enum": [
              "non-commercial",
              "commercial-use",
              "commercial-remix"
            ]
          },
          "commercial_rev_share_pct": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100,
            "nullable": true
          },
          "primary_content_ref": {
            "type": "string"
          },
          "primary_content_hash": {
            "type": "string",
            "nullable": true
          },
          "publication_status": {
            "type": "string",
            "enum": [
              "draft",
              "story_requested",
              "story_published",
              "story_failed",
              "withdrawn"
            ]
          },
          "story_status": {
            "type": "string",
            "enum": [
              "none",
              "requested",
              "published",
              "failed"
            ]
          },
          "story_error": {
            "type": "string",
            "nullable": true
          },
          "story_ip_id": {
            "type": "string",
            "nullable": true
          },
          "story_ip_nft_contract": {
            "type": "string",
            "nullable": true
          },
          "story_ip_nft_token_id": {
            "type": "string",
            "nullable": true
          },
          "story_publish_model": {
            "type": "string",
            "enum": [
              "pirate_v1",
              "story_ip_v1"
            ]
          },
          "story_license_terms_id": {
            "type": "string",
            "nullable": true
          },
          "story_license_template": {
            "type": "string",
            "nullable": true
          },
          "story_royalty_policy": {
            "type": "string",
            "nullable": true
          },
          "story_royalty_policy_id": {
            "type": "string",
            "nullable": true
          },
          "story_derivative_parent_ip_ids": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
          },
          "story_derivative_registered_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "story_revenue_token": {
            "type": "string",
            "nullable": true
          },
          "story_royalty_registration_status": {
            "type": "string",
            "enum": [
              "none",
              "pending",
              "registered",
              "failed"
            ]
          },
          "story_publish_tx_ref": {
            "type": "string",
            "nullable": true
          },
          "story_asset_version_id": {
            "type": "string",
            "nullable": true
          },
          "story_cdr_vault_uuid": {
            "type": "integer",
            "nullable": true
          },
          "story_namespace": {
            "type": "string",
            "nullable": true
          },
          "story_entitlement_token_id": {
            "type": "string",
            "nullable": true
          },
          "story_read_condition": {
            "type": "string",
            "nullable": true
          },
          "story_write_condition": {
            "type": "string",
            "nullable": true
          },
          "locked_delivery_status": {
            "type": "string",
            "enum": [
              "none",
              "requested",
              "ready",
              "failed"
            ]
          },
          "locked_delivery_ref": {
            "type": "string",
            "nullable": true
          },
          "locked_delivery_error": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "AssetAccessResponse": {
        "type": "object",
        "required": [
          "asset_id",
          "community_id",
          "source_post_id",
          "access_mode",
          "source_post_status",
          "story_status",
          "locked_delivery_status",
          "access_granted",
          "decision_reason",
          "delivery_kind",
          "delivery_ref"
        ],
        "properties": {
          "asset_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "source_post_id": {
            "type": "string"
          },
          "access_mode": {
            "type": "string",
            "enum": [
              "public",
              "locked"
            ]
          },
          "source_post_status": {
            "type": "string",
            "enum": [
              "draft",
              "published",
              "hidden"
            ]
          },
          "story_status": {
            "type": "string",
            "enum": [
              "none",
              "requested",
              "published",
              "failed"
            ]
          },
          "locked_delivery_status": {
            "type": "string",
            "enum": [
              "none",
              "requested",
              "ready",
              "failed"
            ]
          },
          "access_granted": {
            "type": "boolean"
          },
          "decision_reason": {
            "type": "string",
            "enum": [
              "public",
              "creator",
              "moderator",
              "purchase_entitlement",
              "purchase_required",
              "delivery_pending"
            ]
          },
          "delivery_kind": {
            "type": "string",
            "nullable": true,
            "enum": [
              "primary_content_ref",
              "locked_delivery_ref",
              "story_cdr_ref"
            ]
          },
          "delivery_ref": {
            "type": "string",
            "nullable": true
          },
          "story_cdr_access": {
            "type": "object",
            "nullable": true,
            "required": [
              "chain_id",
              "rpc_url",
              "cdr_contract_address",
              "read_condition_address",
              "ciphertext_ref",
              "cipher_algorithm",
              "cipher_iv_b64",
              "mime_type",
              "vault_uuid",
              "namespace",
              "access_scope",
              "access_ref",
              "access_proof"
            ],
            "properties": {
              "chain_id": {
                "type": "integer"
              },
              "rpc_url": {
                "type": "string"
              },
              "cdr_contract_address": {
                "type": "string"
              },
              "read_condition_address": {
                "type": "string"
              },
              "ciphertext_ref": {
                "type": "string"
              },
              "cipher_algorithm": {
                "type": "string"
              },
              "cipher_iv_b64": {
                "type": "string"
              },
              "mime_type": {
                "type": "string"
              },
              "vault_uuid": {
                "type": "integer"
              },
              "namespace": {
                "type": "string"
              },
              "access_scope": {
                "type": "string",
                "enum": [
                  "asset.owner",
                  "asset.share"
                ]
              },
              "access_ref": {
                "type": "string"
              },
              "access_aux_data_hex": {
                "type": "string"
              },
              "access_proof": {
                "type": "object",
                "additionalProperties": true
              }
            }
          }
        }
      },
      "HomeFeedCommunitySummary": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_id",
          "display_name",
          "updated_at"
        ],
        "properties": {
          "community_id": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "route_slug": {
            "type": "string",
            "nullable": true
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "member_count": {
            "type": "integer",
            "nullable": true
          },
          "follower_count": {
            "type": "integer",
            "nullable": true
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "SentinelWalletEnsureResponse": {
        "type": "object",
        "required": [
          "wallet_attachment_id",
          "chain_namespace",
          "wallet_address",
          "public_key_hex",
          "source_provider",
          "created_now"
        ],
        "properties": {
          "wallet_attachment_id": {
            "type": "string"
          },
          "chain_namespace": {
            "type": "string",
            "enum": [
              "cosmos:sentinel"
            ]
          },
          "wallet_address": {
            "type": "string"
          },
          "public_key_hex": {
            "type": "string",
            "description": "Hex-encoded compressed secp256k1 public key for the linked Sentinel wallet.\n"
          },
          "source_provider": {
            "type": "string",
            "enum": [
              "privy"
            ]
          },
          "created_now": {
            "type": "boolean",
            "description": "`true` when this call created or first persisted the Sentinel wallet attachment.\n"
          }
        }
      },
      "AgentOwnershipPairing": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "pairing_code",
          "expires_at"
        ],
        "properties": {
          "pairing_code": {
            "type": "string"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "AgentOwnershipPairingClaimRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "pairing_code",
          "agent_challenge"
        ],
        "properties": {
          "pairing_code": {
            "type": "string"
          },
          "agent_challenge": {
            "$ref": "./agents.yaml#/AgentChallenge"
          }
        }
      },
      "AgentOwnershipPairingClaimResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "agent_ownership_session_id",
          "registration_url",
          "connection_token"
        ],
        "properties": {
          "agent_ownership_session_id": {
            "type": "string"
          },
          "registration_url": {
            "type": "string"
          },
          "connection_token": {
            "type": "string"
          }
        }
      },
      "SentinelSubscriptionEnsureResponse": {
        "type": "object",
        "required": [
          "sentinel_subscription_id",
          "wallet_attachment_id",
          "wallet_address",
          "plan_key",
          "chain_subscription_id",
          "status",
          "created_now"
        ],
        "properties": {
          "sentinel_subscription_id": {
            "type": "string"
          },
          "wallet_attachment_id": {
            "type": "string"
          },
          "wallet_address": {
            "type": "string"
          },
          "plan_key": {
            "type": "string",
            "description": "Pirate-side plan key used to map a paid dVPN entitlement onto Sentinel allocation.\n"
          },
          "chain_subscription_id": {
            "type": "string"
          },
          "allocation_tx_hash": {
            "type": "string",
            "nullable": true
          },
          "allocated_bytes": {
            "type": "integer",
            "nullable": true,
            "format": "int64"
          },
          "expires_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "active"
            ]
          },
          "created_now": {
            "type": "boolean",
            "description": "`true` when this call created and persisted a new Sentinel subscription allocation.\n"
          }
        }
      },
      "VerificationRequirement": {
        "type": "object",
        "required": [
          "proof_type"
        ],
        "properties": {
          "proof_type": {
            "type": "string",
            "enum": [
              "minimum_age"
            ]
          },
          "minimum_age": {
            "type": "integer",
            "minimum": 18,
            "maximum": 125,
            "description": "Minimum age threshold requested from the verifier."
          }
        }
      },
      "RefreshPassportWalletScoreRequest": {
        "type": "object",
        "properties": {
          "wallet_attachment_id": {
            "type": "string",
            "nullable": true
          },
          "community_id": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "RefreshPassportWalletScoreResponse": {
        "type": "object",
        "required": [
          "wallet_score"
        ],
        "properties": {
          "wallet_score": {
            "$ref": "./verification.yaml#/WalletScoreCapabilityState"
          },
          "wallet_score_status": {
            "type": "object",
            "nullable": true,
            "properties": {
              "current_score": {
                "type": "number",
                "nullable": true
              },
              "required_score": {
                "type": "number",
                "nullable": true
              },
              "passing_score": {
                "type": "boolean",
                "nullable": true
              },
              "last_score_timestamp": {
                "type": "string",
                "nullable": true
              }
            }
          },
          "join_eligibility": {
            "$ref": "./communities-core.yaml#/JoinEligibility",
            "nullable": true
          }
        }
      },
      "PostCreatorRelation": {
        "type": "string",
        "enum": [
          "captured",
          "created",
          "subject",
          "authorized_repost",
          "fan_work",
          "found"
        ]
      },
      "PromotionAffiliationKind": {
        "type": "string",
        "enum": [
          "self",
          "brand",
          "client",
          "partner",
          "employer",
          "other"
        ]
      },
      "PromotionDisclosureInput": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "is_promotional",
          "affiliation_kind"
        ],
        "properties": {
          "is_promotional": {
            "type": "boolean"
          },
          "affiliation_kind": {
            "$ref": "./posts.yaml#/PromotionAffiliationKind"
          }
        }
      },
      "PromotionDisclosure": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "is_promotional",
          "affiliation_kind"
        ],
        "properties": {
          "is_promotional": {
            "type": "boolean"
          },
          "affiliation_kind": {
            "$ref": "./posts.yaml#/PromotionAffiliationKind"
          }
        }
      },
      "ImageMediaDescriptor": {
        "type": "object",
        "description": "Media descriptor constrained to image MIME types for image posts. The server should reject\nany item whose `mime_type` does not start with `image/`.\n",
        "required": [
          "storage_ref",
          "mime_type"
        ],
        "properties": {
          "storage_ref": {
            "type": "string"
          },
          "mime_type": {
            "type": "string",
            "pattern": "^image/"
          },
          "size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          },
          "width": {
            "type": "integer",
            "nullable": true
          },
          "height": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "VideoMediaDescriptor": {
        "type": "object",
        "description": "Media descriptor constrained to video MIME types for video posts. The server should reject\nany item whose `mime_type` does not start with `video/`. `poster_*` fields describe a\npublic poster image derived from a selected video frame; locked video posts may expose\nposter fields while omitting the raw video storage reference from read models.\n",
        "required": [
          "storage_ref",
          "mime_type"
        ],
        "properties": {
          "storage_ref": {
            "type": "string"
          },
          "mime_type": {
            "type": "string",
            "pattern": "^video/"
          },
          "size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          },
          "duration_ms": {
            "type": "integer",
            "nullable": true
          },
          "width": {
            "type": "integer",
            "nullable": true
          },
          "height": {
            "type": "integer",
            "nullable": true
          },
          "poster_ref": {
            "type": "string",
            "nullable": true
          },
          "poster_mime_type": {
            "type": "string",
            "nullable": true,
            "pattern": "^image/"
          },
          "poster_size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "poster_width": {
            "type": "integer",
            "nullable": true
          },
          "poster_height": {
            "type": "integer",
            "nullable": true
          },
          "poster_frame_ms": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "AudioMediaDescriptor": {
        "type": "object",
        "description": "Media descriptor constrained to audio MIME types for song posts. The server should reject\nany item whose `mime_type` does not start with `audio/`.\n",
        "required": [
          "storage_ref",
          "mime_type"
        ],
        "properties": {
          "storage_ref": {
            "type": "string"
          },
          "mime_type": {
            "type": "string",
            "pattern": "^audio/"
          },
          "size_bytes": {
            "type": "integer",
            "nullable": true
          },
          "content_hash": {
            "type": "string",
            "nullable": true
          },
          "duration_ms": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "DisclosedQualifierSnapshot": {
        "type": "object",
        "required": [
          "qualifier_template_id",
          "rendered_label",
          "qualifier_kind",
          "qualifier_source"
        ],
        "properties": {
          "qualifier_template_id": {
            "type": "string"
          },
          "rendered_label": {
            "type": "string"
          },
          "qualifier_kind": {
            "type": "string",
            "enum": [
              "verification_capability",
              "provider_attestation"
            ]
          },
          "qualifier_source": {
            "type": "string"
          },
          "sensitivity_level": {
            "type": "string",
            "enum": [
              "low",
              "high"
            ],
            "nullable": true
          },
          "redundancy_key": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "PostVoteResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "post_id",
          "value"
        ],
        "properties": {
          "post_id": {
            "type": "string"
          },
          "value": {
            "type": "integer",
            "enum": [
              -1,
              1
            ]
          }
        }
      },
      "CommunityMarketContextMode": {
        "type": "string",
        "enum": [
          "off",
          "on"
        ]
      },
      "CommunityMarketContextProviderSet": {
        "type": "string",
        "enum": [
          "platform_default",
          "approved_profile"
        ]
      },
      "MarketContextProfileStatus": {
        "type": "string",
        "enum": [
          "active",
          "archived"
        ]
      },
      "ModerationSignalSeverity": {
        "type": "string",
        "enum": [
          "low",
          "medium",
          "high"
        ]
      },
      "ModerationCaseStatus": {
        "type": "string",
        "enum": [
          "open",
          "resolved"
        ]
      },
      "ModerationQueueScope": {
        "type": "string",
        "enum": [
          "community",
          "platform"
        ]
      },
      "ModerationCaseOpenedBy": {
        "type": "string",
        "enum": [
          "platform_analysis",
          "user_report",
          "mixed"
        ]
      }
    }
  }
} as const

export default spec
