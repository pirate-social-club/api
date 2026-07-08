// GENERATED FILE. Run `bun run scripts/generate-openapi-spec.ts` to regenerate.
// Source: core/specs/api/openapi.yaml paths filtered through core/specs/api/openapi-implemented.yaml

const spec = {
  "openapi": "3.0.3",
  "info": {
    "title": "Pirate API",
    "version": "0.1.0"
  },
  "servers": [
    {
      "url": "https://api.pirate.example",
      "description": "Placeholder production server"
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
      "name": "Public Names"
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
      "name": "Bookings"
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
      "name": "Song Study"
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
                            "nullable": true
                          },
                          "wallet_address": {
                            "type": "string",
                            "nullable": true
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
                            "type": "string"
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
    "/oauth/device_authorize": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Start OAuth device authorization for Freedom Desktop",
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/OAuthDeviceAuthorizeRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "headers": {
              "Cache-Control": {
                "schema": {
                  "type": "string"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/OAuthDeviceAuthorizeResponse"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          }
        },
        "operationId": "post_oauth_device_authorize"
      }
    },
    "/oauth/device/verify": {
      "get": {
        "tags": [
          "Auth"
        ],
        "summary": "Authorize a pending OAuth device code for the authenticated user",
        "parameters": [
          {
            "in": "query",
            "name": "user_code",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/OAuthDeviceVerifyResponse"
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
        "operationId": "get_oauth_device_verify"
      },
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Authorize a pending OAuth device code for the authenticated user",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/OAuthDeviceVerifyRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/OAuthDeviceVerifyResponse"
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
        "operationId": "post_oauth_device_verify"
      }
    },
    "/oauth/device/token": {
      "post": {
        "tags": [
          "Auth"
        ],
        "summary": "Poll or refresh an OAuth device credential",
        "security": [],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/OAuthDeviceTokenRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "headers": {
              "Cache-Control": {
                "schema": {
                  "type": "string"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/OAuthDeviceTokenResponse"
                }
              }
            }
          },
          "400": {
            "content": {
              "application/json": {
                "schema": {
                  "oneOf": [
                    {
                      "$ref": "#/components/schemas/OAuthDeviceAuthorizationPendingResponse"
                    },
                    {
                      "$ref": "#/components/schemas/Error"
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
        "operationId": "post_oauth_device_token"
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
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/WalletScoreCapabilityState"
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
        "summary": "Get the current Passport wallet score capability",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/WalletScoreCapabilityState"
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
    "/verification/altcha/challenge": {
      "get": {
        "tags": [
          "Verification"
        ],
        "summary": "Create an ALTCHA proof-of-work challenge",
        "parameters": [
          {
            "name": "scope",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string",
              "enum": [
                "community_join",
                "post_create",
                "comment_create",
                "vote"
              ]
            }
          },
          {
            "name": "action",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string",
              "minLength": 1,
              "maxLength": 300
            }
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true
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
          "429": {
            "$ref": "#/components/responses/RateLimited"
          }
        },
        "operationId": "get_verification_altcha_challenge"
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
            "$ref": "#/components/parameters/VerificationSessionId"
          }
        ],
        "responses": {
          "200": {
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
    "/verification-sessions/{verification_session_id}/receive-self-proof": {
      "post": {
        "tags": [
          "Verification"
        ],
        "security": [],
        "summary": "Receive a Self proof callback",
        "parameters": [
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
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "status",
                    "verification_session"
                  ],
                  "properties": {
                    "status": {
                      "type": "string"
                    },
                    "verification_session": {
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
        "operationId": "post_verification_sessions_by_verification_session_id_receive_self_proof"
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
        "responses": {
          "201": {
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
            "$ref": "#/components/parameters/AgentOwnershipSessionId"
          }
        ],
        "responses": {
          "200": {
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
        "parameters": [
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
    "/agent-ownership-sessions/{agent_ownership_session_id}/receive-callback": {
      "post": {
        "tags": [
          "Agents"
        ],
        "security": [],
        "summary": "Receive an asynchronous provider callback for an agent ownership session",
        "parameters": [
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
        "operationId": "post_agent_ownership_sessions_by_agent_ownership_session_id_receive_callback"
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
            "$ref": "#/components/parameters/AgentId"
          }
        ],
        "responses": {
          "200": {
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
      },
      "post": {
        "tags": [
          "Agents"
        ],
        "summary": "Update a user-owned agent",
        "parameters": [
          {
            "$ref": "#/components/parameters/AgentId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdateUserAgentRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/UserAgent"
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
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_agents_by_agent_id"
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
            "$ref": "#/components/parameters/AgentId"
          }
        ],
        "responses": {
          "200": {
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
        "parameters": [
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
        "parameters": [
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
    "/agents/{agent_id}/refresh-credential": {
      "post": {
        "tags": [
          "Agents"
        ],
        "summary": "Refresh a delegated credential for a user-owned agent",
        "parameters": [
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
        "operationId": "post_agents_by_agent_id_refresh_credential"
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
            "$ref": "#/components/parameters/HandleLabel"
          }
        ],
        "responses": {
          "200": {
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
            "$ref": "#/components/parameters/NamespaceVerificationSessionId"
          }
        ],
        "responses": {
          "200": {
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
            "$ref": "#/components/parameters/NamespaceVerificationId"
          }
        ],
        "responses": {
          "200": {
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
        "responses": {
          "200": {
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
            }
          }
        ],
        "responses": {
          "200": {
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
    "/users/me/identity-wallet": {
      "put": {
        "tags": [
          "Users"
        ],
        "summary": "Set the current user's identity wallet",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/SetIdentityWalletRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/User"
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
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "put_users_me_identity_wallet"
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
      "post": {
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
        "operationId": "post_profiles_me"
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
                  "xmtp_inbox"
                ],
                "properties": {
                  "xmtp_inbox": {
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
    "/profiles/me/rename-global-handle": {
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
        "operationId": "post_profiles_me_rename_global_handle"
      }
    },
    "/profiles/me/quote-handle-upgrade": {
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
        "operationId": "post_profiles_me_quote_handle_upgrade"
      }
    },
    "/profiles/me/sync-linked-handles": {
      "post": {
        "tags": [
          "Profiles"
        ],
        "summary": "Refresh wallet-derived linked handles for the current profile",
        "responses": {
          "200": {
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
        "operationId": "post_profiles_me_sync_linked_handles"
      }
    },
    "/profiles/me/set-primary-public-handle": {
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
                  "linked_handle": {
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
        "operationId": "post_profiles_me_set_primary_public_handle"
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
            "$ref": "#/components/parameters/UserId"
          }
        ],
        "responses": {
          "200": {
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
    "/wallet-identities/{chain_ref}/{wallet_address}": {
      "get": {
        "tags": [
          "Profiles"
        ],
        "security": [],
        "summary": "Resolve a public wallet identity",
        "parameters": [
          {
            "name": "chain_ref",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
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
            "headers": {
              "Cache-Control": {
                "schema": {
                  "type": "string"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/WalletIdentityResponse"
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
        "operationId": "get_wallet_identities_by_chain_ref_by_wallet_address"
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
    "/public-names/quotes": {
      "post": {
        "tags": [
          "Public Names"
        ],
        "security": [],
        "summary": "Quote a public wallet-owned .pirate name purchase",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/PublicNameQuoteRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PublicNameQuote"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
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
        "operationId": "post_public_names_quotes"
      }
    },
    "/public-names/claims": {
      "post": {
        "tags": [
          "Public Names"
        ],
        "security": [],
        "summary": "Claim a public wallet-owned .pirate name after checkout funding",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/PublicNameClaimRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PublicNameRegistrationResponse"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
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
        "operationId": "post_public_names_claims"
      }
    },
    "/public-names/{label}/status": {
      "get": {
        "tags": [
          "Public Names"
        ],
        "security": [],
        "summary": "Check public .pirate name availability or wallet-owned registration status",
        "parameters": [
          {
            "name": "label",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PublicNameStatus"
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
        "operationId": "get_public_names_by_label_status"
      }
    },
    "/communities": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Create a community",
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
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Configure or update the money policy for a community",
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
                "$ref": "#/components/schemas/UpdateCommunityMoneyPolicyRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
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
        "operationId": "post_communities_by_community_id_money_policy"
      }
    },
    "/communities/{community_id}/pricing-policy": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Get the active pricing policy for a community",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Configure or update the pricing policy for a community",
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
                "$ref": "#/components/schemas/UpdateCommunityPricingPolicyRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
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
        "operationId": "post_communities_by_community_id_pricing_policy"
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
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Update a community listing",
        "parameters": [
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
        "operationId": "post_communities_by_community_id_listings_by_listing_id"
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
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
                "$ref": "#/components/schemas/CommunityPurchaseQuotePreflightRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
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
                "$ref": "#/components/schemas/CommunityPurchaseQuoteRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
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
                "$ref": "#/components/schemas/CommunityPurchaseSettlementRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
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
    "/communities/{community_id}/fail-purchase-settlement": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Mark a community purchase quote as failed",
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
                "$ref": "#/components/schemas/CommunityPurchaseSettlementFailureRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
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
        "operationId": "post_communities_by_community_id_fail_purchase_settlement"
      }
    },
    "/communities/{community_id}/join": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Join a community",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Follow a community",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
        "operationId": "post_communities_by_community_id_follow"
      }
    },
    "/communities/{community_id}/unfollow": {
      "post": {
        "tags": [
          "Communities"
        ],
        "summary": "Unfollow a community",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
        "operationId": "post_communities_by_community_id_unfollow"
      }
    },
    "/communities/{community_id}/preview": {
      "get": {
        "tags": [
          "Communities"
        ],
        "summary": "Preview a community as a viewer",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
    "/communities/{community_id}/live-rooms/{live_room_id}/recording-draft": {
      "get": {
        "tags": [
          "Livestreams"
        ],
        "summary": "Get a host-visible livestream recording draft",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/LiveRoomId"
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/LiveRoomRecordingDraft"
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
        "operationId": "get_communities_by_community_id_live_rooms_by_live_room_id_recording_draft"
      }
    },
    "/communities/{community_id}/live-rooms/{live_room_id}/replay-draft": {
      "get": {
        "tags": [
          "Livestreams"
        ],
        "summary": "Get a host-visible livestream replay draft",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/LiveRoomId"
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/LiveRoomRecordingDraft"
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
        "operationId": "get_communities_by_community_id_live_rooms_by_live_room_id_replay_draft"
      },
      "patch": {
        "tags": [
          "Livestreams"
        ],
        "summary": "Update a livestream replay draft",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/LiveRoomId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdateLiveRoomReplayDraftRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/LiveRoomRecordingDraft"
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
        "operationId": "patch_communities_by_community_id_live_rooms_by_live_room_id_replay_draft"
      }
    },
    "/communities/{community_id}/live-rooms/{live_room_id}/replay-draft/publish": {
      "post": {
        "tags": [
          "Livestreams"
        ],
        "summary": "Publish a livestream replay draft",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/LiveRoomId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/PublishLiveRoomReplayDraftRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/LiveRoomRecordingDraft"
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
        "operationId": "post_communities_by_community_id_live_rooms_by_live_room_id_replay_draft_publish"
      }
    },
    "/communities/{community_id}/live-rooms/{live_room_id}/replay/access": {
      "get": {
        "tags": [
          "Livestreams"
        ],
        "summary": "Resolve authenticated replay access",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/LiveRoomId"
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/LiveRoomReplayAccessDecision"
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
        "operationId": "get_communities_by_community_id_live_rooms_by_live_room_id_replay_access"
      }
    },
    "/communities/{community_id}/live-rooms/{live_room_id}/replay/content": {
      "get": {
        "tags": [
          "Livestreams"
        ],
        "summary": "Fetch authenticated replay bytes",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/LiveRoomId"
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/octet-stream": {
                "schema": {
                  "type": "string",
                  "format": "binary"
                }
              }
            }
          },
          "206": {
            "content": {
              "application/octet-stream": {
                "schema": {
                  "type": "string",
                  "format": "binary"
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
        "operationId": "get_communities_by_community_id_live_rooms_by_live_room_id_replay_content"
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
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreatePostRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Post"
                }
              }
            }
          },
          "202": {
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
        "parameters": [
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
    "/communities/{community_id}/posts/pending": {
      "get": {
        "tags": [
          "Posts"
        ],
        "summary": "List the caller's pending posts in a community",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/Locale"
          },
          {
            "$ref": "#/components/parameters/Limit"
          }
        ],
        "responses": {
          "200": {
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
        "operationId": "get_communities_by_community_id_posts_pending"
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
    "/communities/{community_id}/posts/{post_id}/remove": {
      "post": {
        "tags": [
          "Moderation"
        ],
        "summary": "Remove a post as a moderator",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/PostId"
          }
        ],
        "responses": {
          "200": {
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
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_communities_by_community_id_posts_by_post_id_remove"
      }
    },
    "/communities/{community_id}/posts/{post_id}/publish-retry": {
      "post": {
        "tags": [
          "Posts"
        ],
        "summary": "Retry asynchronous post publication",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/PostId"
          }
        ],
        "responses": {
          "202": {
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
        "operationId": "post_communities_by_community_id_posts_by_post_id_publish_retry"
      }
    },
    "/communities/{community_id}/posts/{post_id}/comments-lock": {
      "post": {
        "tags": [
          "Moderation"
        ],
        "summary": "Lock or unlock comments on a post thread",
        "parameters": [
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
                "$ref": "#/components/schemas/CommentLockRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
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
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_communities_by_community_id_posts_by_post_id_comments_lock"
      }
    },
    "/communities/{community_id}/posts/{post_id}/reports": {
      "post": {
        "tags": [
          "Moderation"
        ],
        "summary": "Report a post in a community",
        "parameters": [
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
    "/communities/{community_id}/posts/{post_id}/karaoke/sessions": {
      "post": {
        "tags": [
          "Karaoke"
        ],
        "summary": "Create or replay a karaoke session for a post",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/PostId"
          },
          {
            "in": "header",
            "name": "Idempotency-Key",
            "required": true,
            "schema": {
              "type": "string",
              "format": "uuid"
            }
          },
          {
            "in": "header",
            "name": "x-request-id",
            "required": false,
            "schema": {
              "type": "string",
              "maxLength": 256
            }
          },
          {
            "in": "header",
            "name": "origin",
            "required": false,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "201": {
            "headers": {
              "X-Request-Id": {
                "schema": {
                  "type": "string"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/KaraokeSession"
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
          },
          "503": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        },
        "operationId": "post_communities_by_community_id_posts_by_post_id_karaoke_sessions"
      }
    },
    "/communities/{community_id}/posts/{post_id}/study": {
      "get": {
        "tags": [
          "Song Study"
        ],
        "summary": "Fetch the study pack for a song post",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/PostId"
          },
          {
            "in": "query",
            "name": "target_language",
            "required": false,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongStudyPayload"
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
        "operationId": "get_communities_by_community_id_posts_by_post_id_study"
      }
    },
    "/communities/{community_id}/posts/{post_id}/study/attempts": {
      "post": {
        "tags": [
          "Song Study"
        ],
        "summary": "Submit a study attempt and receive the server verdict",
        "parameters": [
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
                "$ref": "#/components/schemas/SongStudyAttemptRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongStudyAttemptResult"
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
          }
        },
        "operationId": "post_communities_by_community_id_posts_by_post_id_study_attempts"
      }
    },
    "/communities/{community_id}/posts/{post_id}/study/transcriptions": {
      "post": {
        "tags": [
          "Song Study"
        ],
        "summary": "Transcribe one study say-it-back recording",
        "parameters": [
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
            "multipart/form-data": {
              "schema": {
                "type": "object",
                "required": [
                  "file"
                ],
                "properties": {
                  "file": {
                    "type": "string",
                    "format": "binary"
                  }
                },
                "additionalProperties": false
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongStudyTranscriptionResponse"
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
          "502": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Error"
                }
              }
            }
          }
        },
        "operationId": "post_communities_by_community_id_posts_by_post_id_study_transcriptions"
      }
    },
    "/communities/{community_id}/posts/{post_id}/streaks/leaderboard": {
      "get": {
        "tags": [
          "Song Study"
        ],
        "summary": "Fetch the song streak leaderboard",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/PostId"
          },
          {
            "in": "query",
            "name": "limit",
            "required": false,
            "schema": {
              "type": "integer",
              "default": 50,
              "maximum": 100,
              "minimum": 1
            }
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongStreakLeaderboard"
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
        "operationId": "get_communities_by_community_id_posts_by_post_id_streaks_leaderboard"
      }
    },
    "/communities/{community_id}/comments/{comment_id}/reports": {
      "post": {
        "tags": [
          "Moderation"
        ],
        "summary": "Report a comment in a community",
        "parameters": [
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
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/ModerationCaseId"
          }
        ],
        "responses": {
          "200": {
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
        "parameters": [
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
    "/communities/{community_id}/rights-review/cases": {
      "get": {
        "tags": [
          "Moderation"
        ],
        "summary": "List rights review cases for a community",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "name": "status",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100,
              "default": 50
            }
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/RightsReviewCaseListResponse"
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
        "operationId": "get_communities_by_community_id_rights_review_cases"
      }
    },
    "/communities/{community_id}/rights-review/cases/{rights_review_case_id}": {
      "get": {
        "tags": [
          "Moderation"
        ],
        "summary": "Read a rights review case",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/RightsReviewCaseId"
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/RightsReviewCaseDetail"
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
        "operationId": "get_communities_by_community_id_rights_review_cases_by_rights_review_case_id"
      }
    },
    "/communities/{community_id}/rights-review/cases/{rights_review_case_id}/actions": {
      "post": {
        "tags": [
          "Moderation"
        ],
        "summary": "Apply a rights review action",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/RightsReviewCaseId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateRightsReviewActionRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/RightsReviewCaseDetail"
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
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_communities_by_community_id_rights_review_cases_by_rights_review_case_id_actions"
      }
    },
    "/communities/{community_id}/song-artifact-uploads": {
      "post": {
        "tags": [
          "Posts"
        ],
        "summary": "Create a song artifact upload intent",
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
                "$ref": "#/components/schemas/CreateSongArtifactUploadRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
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
        "parameters": [
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
      "get": {
        "tags": [
          "Posts"
        ],
        "summary": "List ready song artifact bundles for the authenticated creator",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "name": "q",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
              "type": "integer",
              "minimum": 1,
              "maximum": 50,
              "default": 25
            }
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongArtifactBundleListResponse"
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
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_communities_by_community_id_song_artifacts"
      },
      "post": {
        "tags": [
          "Posts"
        ],
        "summary": "Register a mainline song artifact bundle for a community",
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
                "$ref": "#/components/schemas/CreateSongArtifactBundleRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
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
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/SongArtifactBundleId"
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/SongArtifactBundle"
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
        "operationId": "get_communities_by_community_id_song_artifacts_by_song_artifact_bundle_id"
      }
    },
    "/karaoke/sessions/{session_id}/websocket": {
      "get": {
        "tags": [
          "Karaoke"
        ],
        "summary": "Upgrade to the karaoke session WebSocket",
        "parameters": [
          {
            "in": "path",
            "name": "session_id",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "in": "query",
            "name": "token",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "in": "header",
            "name": "upgrade",
            "required": true,
            "schema": {
              "type": "string",
              "enum": [
                "websocket"
              ]
            }
          }
        ],
        "responses": {
          "101": {},
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_karaoke_sessions_by_session_id_websocket"
      }
    },
    "/bookings": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "summary": "List authenticated user's bookings",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "object",
                    "data",
                    "has_more"
                  ],
                  "properties": {
                    "object": {
                      "type": "string",
                      "enum": [
                        "list"
                      ]
                    },
                    "data": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Booking"
                      }
                    },
                    "has_more": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        },
        "operationId": "get_bookings"
      }
    },
    "/bookings/hosts/{host_user_id}/slots": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "security": [],
        "summary": "Resolve public bookable slots for a host",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BookingSlotsResponse"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_bookings_hosts_by_host_user_id_slots",
        "parameters": [
          {
            "name": "host_user_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/booking-hosts/{host_user_id}/slots": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "security": [],
        "summary": "Resolve public bookable slots for a host",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BookingSlotsResponse"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_bookings_booking_hosts_by_host_user_id_slots",
        "parameters": [
          {
            "name": "host_user_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/hosts/{host_user_id}/holds": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Create a booking hold for a host slot",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateBookingHoldRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "hold"
                  ],
                  "properties": {
                    "hold": {
                      "$ref": "#/components/schemas/BookingHold"
                    }
                  }
                }
              }
            }
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_bookings_hosts_by_host_user_id_holds",
        "parameters": [
          {
            "name": "host_user_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/booking-hosts/{host_user_id}/holds": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Create a booking hold for a host slot",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateBookingHoldRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "hold"
                  ],
                  "properties": {
                    "hold": {
                      "$ref": "#/components/schemas/BookingHold"
                    }
                  }
                }
              }
            }
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_bookings_booking_hosts_by_host_user_id_holds",
        "parameters": [
          {
            "name": "host_user_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/holds/{hold_id}/quote": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Quote a booking hold",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "quote"
                  ],
                  "properties": {
                    "quote": {
                      "$ref": "#/components/schemas/BookingQuote"
                    }
                  }
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_bookings_holds_by_hold_id_quote",
        "parameters": [
          {
            "name": "hold_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/booking-holds/{hold_id}/quote": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Quote a booking hold",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "quote"
                  ],
                  "properties": {
                    "quote": {
                      "$ref": "#/components/schemas/BookingQuote"
                    }
                  }
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_bookings_booking_holds_by_hold_id_quote",
        "parameters": [
          {
            "name": "hold_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/holds/{hold_id}/confirm": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Confirm a paid booking hold",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/ConfirmBookingHoldRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "booking",
                    "already_confirmed"
                  ],
                  "properties": {
                    "booking": {
                      "$ref": "#/components/schemas/Booking"
                    },
                    "already_confirmed": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          },
          "201": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "booking",
                    "already_confirmed"
                  ],
                  "properties": {
                    "booking": {
                      "$ref": "#/components/schemas/Booking"
                    },
                    "already_confirmed": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        },
        "operationId": "post_bookings_holds_by_hold_id_confirm",
        "parameters": [
          {
            "name": "hold_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/booking-holds/{hold_id}/confirm": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Confirm a paid booking hold",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/ConfirmBookingHoldRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "booking",
                    "already_confirmed"
                  ],
                  "properties": {
                    "booking": {
                      "$ref": "#/components/schemas/Booking"
                    },
                    "already_confirmed": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          },
          "201": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "booking",
                    "already_confirmed"
                  ],
                  "properties": {
                    "booking": {
                      "$ref": "#/components/schemas/Booking"
                    },
                    "already_confirmed": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        },
        "operationId": "post_bookings_booking_holds_by_hold_id_confirm",
        "parameters": [
          {
            "name": "hold_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/settlement-review/pending": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "summary": "List pending booking settlement reviews",
        "security": [
          {
            "operatorCredentialAuth": []
          }
        ],
        "responses": {
          "200": {
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
        "operationId": "get_bookings_settlement_review_pending"
      }
    },
    "/bookings/{booking_id}": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "summary": "Get a booking visible to the authenticated party",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "booking"
                  ],
                  "properties": {
                    "booking": {
                      "$ref": "#/components/schemas/Booking"
                    }
                  }
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_bookings_by_booking_id",
        "parameters": [
          {
            "name": "booking_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/{booking_id}/settlement-review": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "summary": "Get a booking settlement review",
        "security": [
          {
            "operatorCredentialAuth": []
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_bookings_by_booking_id_settlement_review",
        "parameters": [
          {
            "name": "booking_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/{booking_id}/settlement-review/resolve": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Resolve an ambiguous booking settlement review",
        "security": [
          {
            "operatorCredentialAuth": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/ResolveBookingSettlementReviewRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ResolveBookingSettlementReviewResponse"
                }
              }
            }
          },
          "202": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ResolveBookingSettlementReviewResponse"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_bookings_by_booking_id_settlement_review_resolve",
        "parameters": [
          {
            "name": "booking_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/{booking_id}/cancel": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Mutate a booking lifecycle state",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true,
                  "required": [
                    "booking"
                  ],
                  "properties": {
                    "booking": {
                      "$ref": "#/components/schemas/Booking"
                    }
                  }
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_bookings_by_booking_id_cancel",
        "parameters": [
          {
            "name": "booking_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/{booking_id}/start": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Mutate a booking lifecycle state",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true,
                  "required": [
                    "booking"
                  ],
                  "properties": {
                    "booking": {
                      "$ref": "#/components/schemas/Booking"
                    }
                  }
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_bookings_by_booking_id_start",
        "parameters": [
          {
            "name": "booking_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/{booking_id}/complete": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Mutate a booking lifecycle state",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true,
                  "required": [
                    "booking"
                  ],
                  "properties": {
                    "booking": {
                      "$ref": "#/components/schemas/Booking"
                    }
                  }
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_bookings_by_booking_id_complete",
        "parameters": [
          {
            "name": "booking_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/{booking_id}/no-show": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Mutate a booking lifecycle state",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true,
                  "required": [
                    "booking"
                  ],
                  "properties": {
                    "booking": {
                      "$ref": "#/components/schemas/Booking"
                    }
                  }
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_bookings_by_booking_id_no_show",
        "parameters": [
          {
            "name": "booking_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/{booking_id}/session/attach": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Attach to a private booking video session",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BookingSessionAttachResponse"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_bookings_by_booking_id_session_attach",
        "parameters": [
          {
            "name": "booking_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/bookings/{booking_id}/session/heartbeat": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Record a booking video session heartbeat",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "session_id"
                ],
                "properties": {
                  "session_id": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "ok"
                  ],
                  "properties": {
                    "ok": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        },
        "operationId": "post_bookings_by_booking_id_session_heartbeat",
        "parameters": [
          {
            "name": "booking_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/host-bookings/me/profile": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "summary": "Get the authenticated host booking profile",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BookingProfileResponse"
                }
              }
            }
          },
          "401": {
            "$ref": "#/components/responses/AuthError"
          }
        },
        "operationId": "get_host_bookings_me_profile"
      },
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Upsert the authenticated host booking profile",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdateBookingProfileRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BookingProfile"
                }
              }
            }
          },
          "201": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BookingProfile"
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
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_host_bookings_me_profile"
      }
    },
    "/host-bookings/me/profile/publish": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Publish the authenticated host booking profile",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BookingProfile"
                }
              }
            }
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_host_bookings_me_profile_publish"
      }
    },
    "/host-bookings/me/profile/unpublish": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Unpublish the authenticated host booking profile",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/BookingProfile"
                }
              }
            }
          }
        },
        "operationId": "post_host_bookings_me_profile_unpublish"
      }
    },
    "/host-bookings/me/availability-rules": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "summary": "List weekly availability rules",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "object",
                    "data",
                    "has_more"
                  ],
                  "properties": {
                    "object": {
                      "type": "string",
                      "enum": [
                        "list"
                      ]
                    },
                    "data": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/AvailabilityRule"
                      }
                    },
                    "has_more": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        },
        "operationId": "get_host_bookings_me_availability_rules"
      },
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Create a weekly availability rule",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateAvailabilityRuleRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AvailabilityRule"
                }
              }
            }
          },
          "400": {
            "$ref": "#/components/responses/BadRequest"
          },
          "409": {
            "$ref": "#/components/responses/Conflict"
          }
        },
        "operationId": "post_host_bookings_me_availability_rules"
      }
    },
    "/host-bookings/me/availability-rules/{rule_id}": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Update a weekly availability rule",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdateAvailabilityRuleRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AvailabilityRule"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_host_bookings_me_availability_rules_by_rule_id",
        "parameters": [
          {
            "name": "rule_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "delete": {
        "tags": [
          "Bookings"
        ],
        "summary": "Delete a weekly availability rule",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "delete_host_bookings_me_availability_rules_by_rule_id",
        "parameters": [
          {
            "name": "rule_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/host-bookings/me/availability-exceptions": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "summary": "List one-off availability exceptions",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "object",
                    "data",
                    "has_more"
                  ],
                  "properties": {
                    "object": {
                      "type": "string",
                      "enum": [
                        "list"
                      ]
                    },
                    "data": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/AvailabilityException"
                      }
                    },
                    "has_more": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        },
        "operationId": "get_host_bookings_me_availability_exceptions"
      },
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Create a one-off availability exception",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreateAvailabilityExceptionRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AvailabilityException"
                }
              }
            }
          }
        },
        "operationId": "post_host_bookings_me_availability_exceptions"
      }
    },
    "/host-bookings/me/availability-exceptions/{exception_id}": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Update a one-off availability exception",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdateAvailabilityExceptionRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/AvailabilityException"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_host_bookings_me_availability_exceptions_by_exception_id",
        "parameters": [
          {
            "name": "exception_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "delete": {
        "tags": [
          "Bookings"
        ],
        "summary": "Delete a one-off availability exception",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "delete_host_bookings_me_availability_exceptions_by_exception_id",
        "parameters": [
          {
            "name": "exception_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/host-bookings/me/price-rules": {
      "get": {
        "tags": [
          "Bookings"
        ],
        "summary": "List variable price rules",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "object",
                    "data",
                    "has_more"
                  ],
                  "properties": {
                    "object": {
                      "type": "string",
                      "enum": [
                        "list"
                      ]
                    },
                    "data": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/PriceRule"
                      }
                    },
                    "has_more": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        },
        "operationId": "get_host_bookings_me_price_rules"
      },
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Create a variable price rule",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CreatePriceRuleRequest"
              }
            }
          }
        },
        "responses": {
          "201": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PriceRule"
                }
              }
            }
          }
        },
        "operationId": "post_host_bookings_me_price_rules"
      }
    },
    "/host-bookings/me/price-rules/{price_rule_id}": {
      "post": {
        "tags": [
          "Bookings"
        ],
        "summary": "Update a variable price rule",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/UpdatePriceRuleRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/PriceRule"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "post_host_bookings_me_price_rules_by_price_rule_id",
        "parameters": [
          {
            "name": "price_rule_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      },
      "delete": {
        "tags": [
          "Bookings"
        ],
        "summary": "Delete a variable price rule",
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "delete_host_bookings_me_price_rules_by_price_rule_id",
        "parameters": [
          {
            "name": "price_rule_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ]
      }
    },
    "/posts/{post_id}": {
      "get": {
        "tags": [
          "Posts"
        ],
        "summary": "Get a post",
        "parameters": [
          {
            "$ref": "#/components/parameters/PostId"
          },
          {
            "$ref": "#/components/parameters/Locale"
          }
        ],
        "responses": {
          "200": {
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
    "/public-communities/{community_id}/live-rooms/{live_room_id}/replay/access": {
      "get": {
        "tags": [
          "Livestreams"
        ],
        "security": [],
        "summary": "Resolve public replay access",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/LiveRoomId"
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/LiveRoomReplayAccessDecision"
                }
              }
            }
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_public_communities_by_community_id_live_rooms_by_live_room_id_replay_access"
      }
    },
    "/public-communities/{community_id}/live-rooms/{live_room_id}/replay/content": {
      "get": {
        "tags": [
          "Livestreams"
        ],
        "security": [],
        "summary": "Fetch public replay bytes",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          },
          {
            "$ref": "#/components/parameters/LiveRoomId"
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/octet-stream": {
                "schema": {
                  "type": "string",
                  "format": "binary"
                }
              }
            }
          },
          "206": {
            "content": {
              "application/octet-stream": {
                "schema": {
                  "type": "string",
                  "format": "binary"
                }
              }
            }
          },
          "403": {
            "$ref": "#/components/responses/EligibilityFailed"
          },
          "404": {
            "$ref": "#/components/responses/NotFound"
          }
        },
        "operationId": "get_public_communities_by_community_id_live_rooms_by_live_room_id_replay_content"
      }
    },
    "/posts/{post_id}/vote": {
      "post": {
        "tags": [
          "Posts"
        ],
        "summary": "Cast or update a vote on a post",
        "parameters": [
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
    "/comments/{comment_id}/remove": {
      "post": {
        "tags": [
          "Comments"
        ],
        "summary": "Remove a comment as a moderator",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommentId"
          }
        ],
        "responses": {
          "200": {
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
        "operationId": "post_comments_by_comment_id_remove"
      }
    },
    "/comments/{comment_id}/delete": {
      "post": {
        "tags": [
          "Comments"
        ],
        "summary": "Tombstone a comment as its author",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommentId"
          }
        ],
        "responses": {
          "200": {
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
        "operationId": "post_comments_by_comment_id_delete"
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
    "/comments/{comment_id}/replies-lock": {
      "post": {
        "tags": [
          "Moderation"
        ],
        "summary": "Lock or unlock replies under a comment",
        "parameters": [
          {
            "$ref": "#/components/parameters/CommentId"
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/CommentLockRequest"
              }
            }
          }
        },
        "responses": {
          "200": {
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
        "operationId": "post_comments_by_comment_id_replies_lock"
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
          "204": {}
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
            "$ref": "#/components/parameters/JobId"
          }
        ],
        "responses": {
          "200": {
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
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "query",
                    "communities",
                    "has_more"
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
                          "community",
                          "display_name"
                        ],
                        "properties": {
                          "community": {
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
                    },
                    "has_more": {
                      "type": "boolean"
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
        "parameters": [
          {
            "$ref": "#/components/parameters/CommunityId"
          }
        ],
        "responses": {
          "200": {
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
    "/public-communities/{community_id}/capabilities": {
      "get": {
        "tags": [
          "Communities"
        ],
        "x-implemented": true,
        "security": [],
        "summary": "Get public community action capabilities",
        "parameters": [
          {
            "name": "community_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "community",
                    "display_name",
                    "read",
                    "write",
                    "raw_policy"
                  ],
                  "additionalProperties": true
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
        "operationId": "get_public_communities_by_community_id_capabilities"
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
        "parameters": [
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
        "parameters": [
          {
            "$ref": "#/components/parameters/PostId"
          }
        ],
        "responses": {
          "200": {
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
        "parameters": [
          {
            "$ref": "#/components/parameters/PostId"
          }
        ],
        "responses": {
          "200": {
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
      },
      "operatorCredentialAuth": {
        "type": "apiKey",
        "in": "header",
        "name": "Authorization",
        "description": "Operator credential sent as `Authorization: Operator ...`."
      }
    },
    "parameters": {
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
      "HandleLabel": {
        "in": "path",
        "name": "handle_label",
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
      "UserId": {
        "in": "path",
        "name": "user_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "CommunityId": {
        "in": "path",
        "name": "community_id",
        "required": true,
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
      "LiveRoomId": {
        "in": "path",
        "name": "live_room_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "Locale": {
        "in": "query",
        "name": "locale",
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
      "PostId": {
        "in": "path",
        "name": "post_id",
        "required": true,
        "schema": {
          "type": "string"
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
      "ModerationCaseId": {
        "in": "path",
        "name": "moderation_case_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      "RightsReviewCaseId": {
        "in": "path",
        "name": "rights_review_case_id",
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
      "SongArtifactBundleId": {
        "in": "path",
        "name": "song_artifact_bundle_id",
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
      }
    },
    "responses": {
      "AuthError": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "BadRequest": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "RateLimited": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "NotFound": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "Conflict": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "Forbidden": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "EligibilityFailed": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "GateFailed": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "VerificationRequired": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "AnalysisBlocked": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "PostingQuotaExhausted": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "#/components/schemas/Error"
            }
          }
        }
      },
      "StructuredSurfaceDisabled": {
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
            }
          }
        }
      }
    },
    "schemas": {
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
            "$ref": "#/components/schemas/User"
          },
          "profile": {
            "$ref": "#/components/schemas/Profile"
          },
          "onboarding": {
            "$ref": "#/components/schemas/OnboardingStatus"
          },
          "wallet_attachments": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/WalletAttachmentSummary"
            }
          }
        }
      },
      "OAuthDeviceAuthorizeRequest": {
        "type": "object",
        "required": [
          "client_id"
        ],
        "properties": {
          "client_id": {
            "type": "string",
            "enum": [
              "freedom-desktop"
            ]
          },
          "scope": {
            "type": "string"
          }
        }
      },
      "OAuthDeviceAuthorizeResponse": {
        "type": "object",
        "required": [
          "device_code",
          "user_code",
          "verification_uri",
          "verification_uri_complete",
          "expires_in",
          "interval"
        ],
        "properties": {
          "device_code": {
            "type": "string"
          },
          "user_code": {
            "type": "string"
          },
          "verification_uri": {
            "type": "string",
            "format": "uri"
          },
          "verification_uri_complete": {
            "type": "string",
            "format": "uri"
          },
          "expires_in": {
            "type": "integer",
            "minimum": 1
          },
          "interval": {
            "type": "integer",
            "minimum": 1
          }
        }
      },
      "OAuthDeviceVerifyResponse": {
        "type": "object",
        "required": [
          "client_id",
          "scope",
          "status",
          "user_code"
        ],
        "properties": {
          "client_id": {
            "type": "string"
          },
          "scope": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "authorized"
            ]
          },
          "user_code": {
            "type": "string"
          }
        }
      },
      "OAuthDeviceVerifyRequest": {
        "type": "object",
        "required": [
          "user_code"
        ],
        "properties": {
          "user_code": {
            "type": "string"
          }
        }
      },
      "OAuthDeviceTokenRequest": {
        "oneOf": [
          {
            "type": "object",
            "required": [
              "client_id",
              "device_code"
            ],
            "properties": {
              "grant_type": {
                "type": "string",
                "enum": [
                  "urn:ietf:params:oauth:grant-type:device_code"
                ]
              },
              "client_id": {
                "type": "string",
                "enum": [
                  "freedom-desktop"
                ]
              },
              "device_code": {
                "type": "string"
              }
            }
          },
          {
            "type": "object",
            "required": [
              "grant_type",
              "client_id",
              "refresh_token"
            ],
            "properties": {
              "grant_type": {
                "type": "string",
                "enum": [
                  "refresh_token"
                ]
              },
              "client_id": {
                "type": "string",
                "enum": [
                  "freedom-desktop"
                ]
              },
              "refresh_token": {
                "type": "string"
              }
            }
          }
        ]
      },
      "OAuthDeviceTokenResponse": {
        "type": "object",
        "required": [
          "access_token",
          "refresh_token",
          "token_type",
          "expires_in",
          "refresh_expires_in",
          "scope"
        ],
        "properties": {
          "access_token": {
            "type": "string"
          },
          "refresh_token": {
            "type": "string"
          },
          "token_type": {
            "type": "string",
            "enum": [
              "Bearer"
            ]
          },
          "expires_in": {
            "type": "integer",
            "minimum": 1
          },
          "refresh_expires_in": {
            "type": "integer",
            "minimum": 1
          },
          "scope": {
            "type": "string"
          }
        }
      },
      "OAuthDeviceAuthorizationPendingResponse": {
        "type": "object",
        "required": [
          "error",
          "error_description",
          "interval"
        ],
        "properties": {
          "error": {
            "type": "string",
            "enum": [
              "authorization_pending"
            ]
          },
          "error_description": {
            "type": "string"
          },
          "interval": {
            "type": "integer",
            "minimum": 1
          }
        }
      },
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
      "StartVerificationSessionRequest": {
        "type": "object",
        "required": [
          "provider"
        ],
        "properties": {
          "provider": {
            "type": "string",
            "enum": [
              "self",
              "very",
              "zkpassport"
            ]
          },
          "provider_mode": {
            "type": "string",
            "enum": [
              "qr_deeplink",
              "widget",
              "native_sdk",
              "web_sdk"
            ],
            "nullable": true
          },
          "requested_capabilities": {
            "type": "array",
            "minItems": 1,
            "items": {
              "$ref": "#/components/schemas/RequestedVerificationCapability"
            }
          },
          "verification_requirements": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "#/components/schemas/VerificationRequirement"
            }
          },
          "wallet_attachment": {
            "type": "string",
            "nullable": true
          },
          "verification_intent": {
            "$ref": "#/components/schemas/VerificationIntent",
            "nullable": true
          },
          "policy": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "VerificationSession": {
        "type": "object",
        "required": [
          "id",
          "object",
          "user",
          "provider",
          "requested_capabilities",
          "status",
          "created",
          "expires_at"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "verification_session"
            ]
          },
          "user": {
            "type": "string"
          },
          "provider": {
            "type": "string",
            "enum": [
              "self",
              "very",
              "zkpassport"
            ]
          },
          "provider_mode": {
            "type": "string",
            "enum": [
              "qr_deeplink",
              "widget",
              "native_sdk",
              "web_sdk"
            ],
            "nullable": true
          },
          "wallet_attachment": {
            "type": "string",
            "nullable": true
          },
          "requested_capabilities": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/RequestedVerificationCapability"
            }
          },
          "verification_requirements": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/VerificationRequirement"
            }
          },
          "verification_intent": {
            "$ref": "#/components/schemas/VerificationIntent",
            "nullable": true
          },
          "policy": {
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
            "$ref": "#/components/schemas/VerificationSessionLaunch"
          },
          "callback_path": {
            "type": "string",
            "nullable": true
          },
          "nationality": {
            "type": "string",
            "nullable": true
          },
          "age_at_verification": {
            "type": "integer",
            "nullable": true
          },
          "attestation": {
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "failure_reason": {
            "type": "string",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64"
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "score_decimal": {
            "type": "string",
            "pattern": "^\\d+(\\.\\d+)?$",
            "nullable": true
          },
          "score_threshold_decimal": {
            "type": "string",
            "pattern": "^\\d+(\\.\\d+)?$",
            "nullable": true
          },
          "passing_score": {
            "type": "boolean",
            "nullable": true
          },
          "last_scored_at": {
            "type": "integer",
            "nullable": true
          },
          "expires_at": {
            "type": "integer",
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
                "stamp_score_decimal": {
                  "type": "string",
                  "pattern": "^\\d+(\\.\\d+)?$"
                }
              }
            }
          }
        }
      },
      "ProviderVerificationCallbackRequest": {
        "type": "object",
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
          "attestation": {
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
      "CompleteVerificationSessionRequest": {
        "type": "object",
        "properties": {
          "attestation": {
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
            ]
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
            ]
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
        "properties": {
          "session_kind": {
            "$ref": "#/components/schemas/AgentOwnershipSessionKind"
          },
          "ownership_provider": {
            "$ref": "#/components/schemas/AgentOwnershipProvider"
          },
          "agent": {
            "type": "string",
            "nullable": true
          },
          "display_name": {
            "type": "string",
            "nullable": true
          },
          "policy": {
            "type": "string",
            "nullable": true
          },
          "agent_challenge": {
            "$ref": "#/components/schemas/AgentChallenge"
          }
        }
      },
      "AgentOwnershipSession": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "object",
          "session_kind",
          "ownership_provider",
          "status",
          "launch",
          "created",
          "expires_at"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "agent_ownership_session"
            ]
          },
          "session_kind": {
            "$ref": "#/components/schemas/AgentOwnershipSessionKind"
          },
          "owner_user": {
            "type": "string",
            "nullable": true
          },
          "agent": {
            "type": "string",
            "nullable": true
          },
          "ownership_provider": {
            "$ref": "#/components/schemas/AgentOwnershipProvider"
          },
          "status": {
            "$ref": "#/components/schemas/AgentOwnershipSessionStatus"
          },
          "agent_challenge_ref": {
            "type": "string"
          },
          "provider_session_ref": {
            "type": "string",
            "nullable": true
          },
          "launch": {
            "$ref": "#/components/schemas/AgentOwnershipSessionLaunch"
          },
          "callback_path": {
            "type": "string",
            "nullable": true
          },
          "resolved_agent_ownership_record": {
            "type": "string",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64"
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
            "type": "integer",
            "format": "int64"
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
            "$ref": "#/components/schemas/AgentChallenge"
          }
        }
      },
      "AgentOwnershipPairingClaimResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "agent_ownership_session",
          "registration_url",
          "connection_token"
        ],
        "properties": {
          "agent_ownership_session": {
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
      "CompleteAgentOwnershipSessionRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "attestation": {
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
        "properties": {
          "provider": {
            "$ref": "#/components/schemas/AgentOwnershipProvider"
          },
          "event_type": {
            "type": "string",
            "nullable": true
          },
          "attestation": {
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
      "UserAgentListResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items",
          "next_cursor"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/UserAgent"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "UserAgent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "object",
          "owner_user",
          "display_name",
          "status",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "user_agent"
            ]
          },
          "owner_user": {
            "type": "string"
          },
          "display_name": {
            "type": "string"
          },
          "handle": {
            "$ref": "#/components/schemas/AgentHandle",
            "nullable": true
          },
          "status": {
            "$ref": "#/components/schemas/UserAgentStatus"
          },
          "current_ownership_record": {
            "type": "string",
            "nullable": true
          },
          "current_ownership": {
            "$ref": "#/components/schemas/AgentOwnershipRecord",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "UpdateUserAgentRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "display_name": {
            "type": "string"
          }
        }
      },
      "AgentHandle": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "object",
          "agent",
          "label_normalized",
          "label_display",
          "status",
          "issued_at",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "agent_handle"
            ]
          },
          "agent": {
            "type": "string"
          },
          "label_normalized": {
            "type": "string"
          },
          "label_display": {
            "type": "string"
          },
          "status": {
            "$ref": "#/components/schemas/AgentHandleStatus"
          },
          "redirect_target_agent_handle": {
            "type": "string",
            "nullable": true
          },
          "issued_at": {
            "type": "integer",
            "format": "int64"
          },
          "replaced_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
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
            "type": "string"
          }
        }
      },
      "AgentDelegatedCredentialIssueRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "current_ownership_record": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "AgentDelegatedCredential": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "object",
          "agent",
          "owner_user",
          "current_ownership_record",
          "token_type",
          "access_token",
          "refresh_token",
          "issued_at",
          "expires_at"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "agent_delegated_credential"
            ]
          },
          "agent": {
            "type": "string"
          },
          "owner_user": {
            "type": "string"
          },
          "current_ownership_record": {
            "type": "string"
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
            "type": "integer",
            "format": "int64"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64"
          },
          "refresh_expires_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
      },
      "AgentDelegatedCredentialRefreshRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "refresh_token"
        ],
        "properties": {
          "refresh_token": {
            "type": "string"
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
              "agent",
              "handle",
              "created"
            ],
            "properties": {
              "agent": {
                "type": "string"
              },
              "display_name": {
                "type": "string",
                "nullable": true
              },
              "handle": {
                "$ref": "#/components/schemas/AgentHandle"
              },
              "ownership_provider": {
                "$ref": "#/components/schemas/AgentOwnershipProvider",
                "nullable": true
              },
              "created": {
                "type": "integer",
                "format": "int64"
              }
            }
          },
          "owner": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "user",
              "global_handle",
              "primary_public_handle"
            ],
            "properties": {
              "user": {
                "type": "string"
              },
              "display_name": {
                "type": "string",
                "nullable": true
              },
              "global_handle": {
                "$ref": "#/components/schemas/GlobalHandle"
              },
              "primary_public_handle": {
                "$ref": "#/components/schemas/LinkedHandle",
                "nullable": true
              }
            }
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
            ]
          },
          "root_label": {
            "type": "string"
          }
        }
      },
      "NamespaceVerificationSession": {
        "type": "object",
        "required": [
          "id",
          "object",
          "user",
          "family",
          "submitted_root_label",
          "status",
          "created",
          "expires_at"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "namespace_verification_session"
            ]
          },
          "namespace_verification": {
            "type": "string",
            "nullable": true
          },
          "user": {
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
            ]
          },
          "challenge_kind": {
            "type": "string",
            "enum": [
              "dns_txt",
              "fabric_txt_publish"
            ],
            "nullable": true
          },
          "challenge_host": {
            "type": "string",
            "nullable": true
          },
          "challenge_txt_value": {
            "type": "string",
            "nullable": true
          },
          "challenge_payload": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          },
          "challenge_expires_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "setup_nameservers": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
          },
          "assertions": {
            "allOf": [
              {
                "$ref": "#/components/schemas/NamespaceVerificationAssertions"
              }
            ],
            "nullable": true
          },
          "capabilities": {
            "allOf": [
              {
                "$ref": "#/components/schemas/NamespaceVerificationCapabilities"
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
            "nullable": true
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "CompleteNamespaceVerificationSessionRequest": {
        "type": "object",
        "properties": {
          "restart_challenge": {
            "type": "boolean",
            "nullable": true
          }
        }
      },
      "NamespaceVerification": {
        "type": "object",
        "required": [
          "id",
          "object",
          "user",
          "family",
          "normalized_root_label",
          "status",
          "assertions",
          "capabilities",
          "accepted_at",
          "expires_at",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "namespace_verification"
            ]
          },
          "user": {
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
            "$ref": "#/components/schemas/NamespaceVerificationAssertions"
          },
          "capabilities": {
            "$ref": "#/components/schemas/NamespaceVerificationCapabilities"
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
            "type": "integer",
            "format": "int64"
          },
          "created": {
            "type": "integer",
            "format": "int64"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64"
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
            "type": "integer",
            "format": "int64",
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
            "nullable": true
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "failure_code": {
            "type": "string",
            "nullable": true,
            "enum": [
              "code_not_found",
              "different_code_found",
              "username_not_found",
              "rate_limited",
              "source_error"
            ]
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
            "$ref": "#/components/schemas/Job"
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
            "type": "integer",
            "format": "int64"
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
            "deprecated": true
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
                "community",
                "name",
                "reason"
              ],
              "properties": {
                "community": {
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
      "User": {
        "type": "object",
        "required": [
          "id",
          "object",
          "verification_state",
          "verification_capabilities",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "user"
            ]
          },
          "community_posting_state": {
            "type": "object",
            "nullable": true,
            "properties": {
              "community_ref": {
                "type": "string"
              },
              "community": {
                "type": "string"
              },
              "has_created_text_post": {
                "type": "boolean"
              }
            }
          },
          "primary_wallet_attachment": {
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
            "nullable": true
          },
          "verification_capabilities": {
            "$ref": "#/components/schemas/VerificationCapabilities"
          },
          "verified_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "SetIdentityWalletRequest": {
        "type": "object",
        "required": [
          "wallet_attachment_id"
        ],
        "properties": {
          "wallet_attachment_id": {
            "type": "string"
          }
        }
      },
      "Profile": {
        "type": "object",
        "required": [
          "id",
          "object",
          "global_handle",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "profile"
            ]
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
              "$ref": "#/components/schemas/LinkedHandle"
            }
          },
          "primary_public_handle": {
            "allOf": [
              {
                "$ref": "#/components/schemas/LinkedHandle"
              }
            ],
            "nullable": true
          },
          "primary_wallet_address": {
            "type": "string",
            "nullable": true
          },
          "is_bookable": {
            "type": "boolean"
          },
          "xmtp_inbox": {
            "type": "string",
            "nullable": true
          },
          "verification_capabilities": {
            "allOf": [
              {
                "$ref": "#/components/schemas/VerificationCapabilities"
              }
            ],
            "nullable": true
          },
          "global_handle": {
            "$ref": "#/components/schemas/GlobalHandle"
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "GlobalHandle": {
        "type": "object",
        "required": [
          "id",
          "object",
          "label",
          "tier",
          "status",
          "issuance_source",
          "issued_at"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "global_handle"
            ]
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
          "redirect_target_global_handle": {
            "type": "string",
            "nullable": true
          },
          "price_paid_cents": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "free_rename_consumed": {
            "type": "boolean"
          },
          "issued_at": {
            "type": "integer",
            "format": "int64"
          },
          "replaced_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
      },
      "HandleUpgradeQuote": {
        "type": "object",
        "required": [
          "desired_label",
          "tier",
          "price_cents",
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
          "price_cents": {
            "type": "integer",
            "minimum": 0
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
            "$ref": "#/components/schemas/Profile"
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
                "community",
                "display_name",
                "created"
              ],
              "properties": {
                "community": {
                  "type": "string"
                },
                "display_name": {
                  "type": "string"
                },
                "route_slug": {
                  "type": "string",
                  "nullable": true
                },
                "created": {
                  "type": "integer",
                  "format": "int64"
                }
              }
            }
          }
        }
      },
      "WalletIdentityResponse": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/WalletIdentity"
          },
          {
            "$ref": "#/components/schemas/WalletIdentityRedirect"
          }
        ],
        "discriminator": {
          "propertyName": "object",
          "mapping": {
            "wallet_identity": "./profiles.yaml#/WalletIdentity",
            "wallet_identity_redirect": "./profiles.yaml#/WalletIdentityRedirect"
          }
        }
      },
      "PublicNameQuoteRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "desired_label",
          "buyer_wallet_address"
        ],
        "properties": {
          "desired_label": {
            "type": "string"
          },
          "buyer_wallet_address": {
            "type": "string"
          }
        }
      },
      "PublicNameQuote": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "quote",
          "desired_label",
          "label_normalized",
          "buyer",
          "price_cents",
          "currency",
          "eligible",
          "reason",
          "policy_version",
          "quote_ttl_seconds",
          "quoted_at",
          "expires_at",
          "payment_instructions"
        ],
        "properties": {
          "quote": {
            "type": "string"
          },
          "desired_label": {
            "type": "string"
          },
          "label_normalized": {
            "type": "string"
          },
          "buyer": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "kind",
              "wallet_address",
              "chain_ref"
            ],
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "wallet"
                ]
              },
              "wallet_address": {
                "type": "string"
              },
              "chain_ref": {
                "type": "string"
              }
            }
          },
          "price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "currency": {
            "type": "string",
            "enum": [
              "USD"
            ]
          },
          "eligible": {
            "type": "boolean",
            "enum": [
              true
            ]
          },
          "reason": {
            "type": "string",
            "nullable": true
          },
          "policy_version": {
            "type": "string"
          },
          "pricing_tier": {
            "type": "string",
            "nullable": true
          },
          "quote_ttl_seconds": {
            "type": "integer",
            "minimum": 1
          },
          "quoted_at": {
            "type": "integer",
            "format": "int64"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64"
          },
          "payment_instructions": {
            "$ref": "#/PublicNamePaymentInstructions"
          }
        }
      },
      "PublicNameClaimRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "quote",
          "funding_tx_ref"
        ],
        "properties": {
          "quote": {
            "type": "string"
          },
          "funding_tx_ref": {
            "type": "string"
          }
        }
      },
      "PublicNameRegistrationResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "registration",
          "quote",
          "funding_tx_ref",
          "settlement_tx_ref"
        ],
        "properties": {
          "registration": {
            "$ref": "#/PublicNameRegistration"
          },
          "quote": {
            "type": "string"
          },
          "funding_tx_ref": {
            "type": "string",
            "nullable": true
          },
          "settlement_tx_ref": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "PublicNameStatus": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "label",
              "label_normalized",
              "status"
            ],
            "properties": {
              "label": {
                "type": "string"
              },
              "label_normalized": {
                "type": "string"
              },
              "status": {
                "type": "string",
                "enum": [
                  "available"
                ]
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "label",
              "label_normalized",
              "status",
              "registration"
            ],
            "properties": {
              "label": {
                "type": "string"
              },
              "label_normalized": {
                "type": "string"
              },
              "status": {
                "type": "string",
                "enum": [
                  "registered"
                ]
              },
              "registration": {
                "$ref": "#/PublicNameRegistration"
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "label",
              "label_normalized",
              "status",
              "owner_kind"
            ],
            "properties": {
              "label": {
                "type": "string"
              },
              "label_normalized": {
                "type": "string"
              },
              "status": {
                "type": "string",
                "enum": [
                  "taken"
                ]
              },
              "owner_kind": {
                "type": "string",
                "enum": [
                  "user"
                ]
              }
            }
          }
        ]
      },
      "CreateCommunityRequest": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/CreateCentralizedCommunityRequest"
          },
          {
            "$ref": "#/components/schemas/CreateMultisigCommunityRequest"
          },
          {
            "$ref": "#/components/schemas/CreateMajeurCommunityRequest"
          }
        ],
        "discriminator": {
          "propertyName": "governance_mode",
          "mapping": {
            "centralized": "#/components/schemas/CreateCentralizedCommunityRequest",
            "multisig": "#/components/schemas/CreateMultisigCommunityRequest",
            "majeur": "#/components/schemas/CreateMajeurCommunityRequest"
          }
        }
      },
      "CommunityCreateAcceptedResponse": {
        "type": "object",
        "required": [
          "community",
          "job"
        ],
        "properties": {
          "community": {
            "$ref": "#/components/schemas/Community"
          },
          "job": {
            "$ref": "#/components/schemas/Job"
          }
        }
      },
      "Community": {
        "type": "object",
        "required": [
          "id",
          "object",
          "display_name",
          "status",
          "provisioning_state",
          "membership_mode",
          "karaoke_enabled",
          "allow_anonymous_identity",
          "human_verification_lane",
          "human_verification_lane_origin",
          "agent_posting_policy",
          "guest_comment_policy",
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
          "visual_policy_settings",
          "provenance_policy",
          "promotion_policy",
          "created_by_user",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community"
            ]
          },
          "display_name": {
            "type": "string"
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          },
          "banner_ref": {
            "type": "string",
            "nullable": true
          },
          "namespace_verification": {
            "type": "string",
            "nullable": true
          },
          "route_slug": {
            "type": "string",
            "nullable": true
          },
          "pending_namespace_verification_session": {
            "type": "string",
            "nullable": true
          },
          "store_url": {
            "type": "string",
            "nullable": true
          },
          "store_label": {
            "type": "string",
            "nullable": true
          },
          "country_code": {
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
            ]
          },
          "artist_identity": {
            "type": "string",
            "nullable": true
          },
          "community_agent_user": {
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
          "karaoke_enabled": {
            "type": "boolean"
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
            "$ref": "#/components/schemas/HumanVerificationLane"
          },
          "human_verification_lane_origin": {
            "$ref": "#/components/schemas/CommunityAgentResolutionOrigin"
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
          "guest_comment_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "altcha_required"
            ]
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
            "$ref": "#/components/schemas/RootPostQuotaByTrustTier",
            "nullable": true
          },
          "reply_quota_by_trust_tier": {
            "$ref": "#/components/schemas/ReplyQuotaByTrustTier",
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
            ]
          },
          "gate_policy": {
            "$ref": "#/components/schemas/GatePolicy",
            "nullable": true
          },
          "agent_posting_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "review",
              "allow_with_disclosure",
              "allow"
            ]
          },
          "agent_posting_scope": {
            "type": "string",
            "enum": [
              "replies_only",
              "top_level_and_replies"
            ]
          },
          "agent_daily_post_cap": {
            "type": "integer",
            "nullable": true
          },
          "agent_daily_reply_cap": {
            "type": "integer",
            "nullable": true
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
          "accepted_agent_ownership_providers": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/AgentOwnershipProvider"
            }
          },
          "accepted_agent_ownership_providers_origin": {
            "$ref": "#/components/schemas/CommunityAgentResolutionOrigin"
          },
          "civic_scale_tier": {
            "type": "string",
            "enum": [
              "club",
              "village",
              "town",
              "city",
              "state"
            ]
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
          "donation_partner": {
            "$ref": "#/components/schemas/DonationPartnerSummary",
            "nullable": true
          },
          "money_policy": {
            "$ref": "#/components/schemas/CommunityMoneyPolicy"
          },
          "content_authenticity_policy": {
            "$ref": "#/components/schemas/CommunityContentAuthenticityPolicy"
          },
          "content_authenticity_detection_policy": {
            "$ref": "#/components/schemas/CommunityContentAuthenticityDetectionPolicy"
          },
          "market_context_policy": {
            "$ref": "#/components/schemas/CommunityMarketContextPolicy"
          },
          "source_policy": {
            "$ref": "#/components/schemas/CommunitySourcePolicy"
          },
          "capture_edit_policy": {
            "$ref": "#/components/schemas/CommunityCaptureEditPolicy"
          },
          "adult_content_policy": {
            "$ref": "#/components/schemas/CommunityAdultContentPolicy"
          },
          "graphic_content_policy": {
            "$ref": "#/components/schemas/CommunityGraphicContentPolicy"
          },
          "motion_media_policy": {
            "$ref": "#/components/schemas/CommunityMotionMediaPolicy"
          },
          "language_policy": {
            "$ref": "#/components/schemas/CommunityLanguagePolicy"
          },
          "civility_policy": {
            "$ref": "#/components/schemas/CommunityCivilityPolicy"
          },
          "visual_policy_settings": {
            "$ref": "#/components/schemas/CommunityVisualPolicySettings"
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
            }
          },
          "provenance_policy": {
            "$ref": "#/components/schemas/CommunityProvenancePolicy"
          },
          "promotion_policy": {
            "$ref": "#/components/schemas/CommunityPromotionPolicy"
          },
          "label_policy": {
            "$ref": "#/components/schemas/CommunityLabelPolicy",
            "nullable": true
          },
          "community_profile": {
            "$ref": "#/components/schemas/CommunityProfile",
            "nullable": true
          },
          "reference_links": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityReferenceLinkPublic"
            },
            "nullable": true
          },
          "community_stage": {
            "type": "string",
            "enum": [
              "initial"
            ]
          },
          "member_count": {
            "type": "integer",
            "nullable": true
          },
          "qualified_member_count": {
            "type": "integer",
            "nullable": true
          },
          "stage_entered_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
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
            "$ref": "#/components/schemas/CommunityGovernanceBackend",
            "nullable": true
          },
          "gate_rules": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/GateRule"
            },
            "nullable": true
          },
          "created_by_user": {
            "type": "string"
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "CommunityMoneyPolicy": {
        "type": "object",
        "required": [
          "id",
          "object",
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
          "route_hop_tolerance"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_money_policy"
            ]
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "funding_preference": {
            "type": "string"
          },
          "accepted_funding_assets": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityMoneyAssetRef"
            }
          },
          "accepted_source_chains": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityMoneyChainRef"
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
            "$ref": "#/components/schemas/CommunityMoneyChainRef"
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
            "$ref": "#/components/schemas/CommunityFundingRouteStatusPolicy"
          },
          "route_hop_tolerance": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "UpdateCommunityMoneyPolicyRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "funding_preference": {
            "type": "string"
          },
          "accepted_funding_assets": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityMoneyAssetRef"
            }
          },
          "accepted_source_chains": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityMoneyChainRef"
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
            "$ref": "#/components/schemas/CommunityMoneyChainRef"
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
            "$ref": "#/components/schemas/CommunityFundingRouteStatusPolicy"
          },
          "route_hop_tolerance": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "CommunityPricingPolicy": {
        "type": "object",
        "required": [
          "id",
          "object",
          "policy_origin",
          "pricing_policy_version",
          "regional_pricing_enabled",
          "tiers",
          "country_assignments"
        ],
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_pricing_policy"
            ]
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "pricing_policy_version": {
            "type": "string"
          },
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "verification_provider_requirement": {
            "$ref": "#/components/schemas/CommunityPricingVerificationProvider",
            "nullable": true
          },
          "default_tier_key": {
            "type": "string",
            "nullable": true
          },
          "tiers": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityPricingTier"
            }
          },
          "country_assignments": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityPricingCountryAssignment"
            }
          },
          "source_template": {
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
        "additionalProperties": false,
        "properties": {
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "verification_provider_requirement": {
            "$ref": "#/components/schemas/CommunityPricingVerificationProvider",
            "nullable": true
          },
          "default_tier_key": {
            "type": "string",
            "nullable": true
          },
          "tiers": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityPricingTier"
            }
          },
          "country_assignments": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityPricingCountryAssignment"
            }
          },
          "source_template": {
            "type": "string",
            "nullable": true
          },
          "source_template_version": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CommunityListingListResponse": {
        "type": "object",
        "required": [
          "items",
          "next_cursor"
        ],
        "additionalProperties": false,
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityListing"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CreateCommunityListingRequest": {
        "type": "object",
        "required": [
          "price_cents",
          "regional_pricing_enabled",
          "status"
        ],
        "additionalProperties": false,
        "properties": {
          "asset": {
            "type": "string",
            "nullable": true
          },
          "live_room": {
            "type": "string",
            "nullable": true
          },
          "replay_asset": {
            "type": "string",
            "nullable": true
          },
          "price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "donation_partner": {
            "type": "string",
            "nullable": true
          },
          "donation_share_bps": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "vinyl_release_provider": {
            "type": "string",
            "enum": [
              "elasticstage"
            ],
            "nullable": true
          },
          "vinyl_release_url": {
            "type": "string",
            "format": "uri",
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
      "CommunityListing": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "listing_mode",
          "status",
          "price_cents",
          "regional_pricing_enabled",
          "created_by_user",
          "created"
        ],
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_listing"
            ]
          },
          "community": {
            "type": "string"
          },
          "asset": {
            "type": "string",
            "nullable": true
          },
          "live_room": {
            "type": "string",
            "nullable": true
          },
          "replay_asset": {
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
          "price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "donation_partner": {
            "type": "string",
            "nullable": true
          },
          "donation_share_bps": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "vinyl_release_provider": {
            "type": "string",
            "enum": [
              "elasticstage"
            ],
            "nullable": true
          },
          "vinyl_release_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          },
          "created_by_user": {
            "type": "string"
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "UpdateCommunityListingRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "donation_partner": {
            "type": "string",
            "nullable": true
          },
          "donation_share_bps": {
            "type": "integer",
            "minimum": 0,
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
      "CommunityPurchaseListResponse": {
        "type": "object",
        "required": [
          "items",
          "next_cursor"
        ],
        "additionalProperties": false,
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityPurchase"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CommunityPurchase": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "listing",
          "buyer_user",
          "settlement_wallet_attachment",
          "purchase_price_cents",
          "settlement_mode",
          "settlement_chain",
          "settlement_token",
          "settlement_tx_ref",
          "allocations",
          "purchase_entitlement",
          "entitlement_kind",
          "entitlement_target_ref",
          "created"
        ],
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_purchase"
            ]
          },
          "community": {
            "type": "string"
          },
          "listing": {
            "type": "string"
          },
          "asset": {
            "type": "string",
            "nullable": true
          },
          "live_room": {
            "type": "string",
            "nullable": true
          },
          "replay_asset": {
            "type": "string",
            "nullable": true
          },
          "buyer_user": {
            "type": "string"
          },
          "settlement_wallet_attachment": {
            "type": "string"
          },
          "purchase_price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "pricing_tier": {
            "type": "string",
            "nullable": true
          },
          "settlement_mode": {
            "$ref": "#/components/schemas/CommunityPurchaseSettlementMode"
          },
          "settlement_chain": {
            "$ref": "#/components/schemas/CommunityMoneyChainRef"
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
              "$ref": "#/components/schemas/CommunitySaleAllocationLeg"
            }
          },
          "donation_partner": {
            "type": "string",
            "nullable": true
          },
          "donation_share_bps": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "donation_amount_cents": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "vinyl_release_provider": {
            "type": "string",
            "enum": [
              "elasticstage"
            ],
            "nullable": true
          },
          "vinyl_release_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          },
          "purchase_entitlement": {
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
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "CommunityPurchaseQuotePreflightRequest": {
        "type": "object",
        "required": [
          "client_estimated_slippage_bps",
          "client_estimated_hop_count"
        ],
        "additionalProperties": false,
        "properties": {
          "listing": {
            "type": "string",
            "nullable": true
          },
          "funding_asset": {
            "$ref": "#/components/schemas/CommunityMoneyAssetRef",
            "nullable": true
          },
          "source_chain": {
            "$ref": "#/components/schemas/CommunityMoneyChainRef",
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
        "required": [
          "community",
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
          "community": {
            "type": "string"
          },
          "eligible": {
            "type": "boolean"
          },
          "funding_mode": {
            "$ref": "#/components/schemas/CommunityPurchaseFundingMode"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "funding_preference": {
            "type": "string"
          },
          "funding_asset": {
            "$ref": "#/components/schemas/CommunityMoneyAssetRef",
            "nullable": true
          },
          "source_chain": {
            "$ref": "#/components/schemas/CommunityMoneyChainRef",
            "nullable": true
          },
          "route_provider": {
            "type": "string",
            "nullable": true
          },
          "destination_settlement_chain": {
            "$ref": "#/components/schemas/CommunityMoneyChainRef"
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
            "$ref": "#/components/schemas/CommunityFundingRouteStatusPolicy"
          },
          "route_hop_tolerance": {
            "type": "integer",
            "minimum": 0
          },
          "base_price_cents": {
            "type": "integer",
            "nullable": true
          },
          "viewer_price_cents": {
            "type": "integer",
            "nullable": true
          },
          "best_verified_price_cents": {
            "type": "integer",
            "nullable": true
          },
          "max_self_discount_bps": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "verification_required_provider": {
            "$ref": "#/components/schemas/CommunityPricingVerificationProvider",
            "nullable": true
          },
          "quoted_at": {
            "type": "integer",
            "format": "int64"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "CommunityPurchaseQuoteRequest": {
        "type": "object",
        "required": [
          "listing",
          "client_estimated_slippage_bps",
          "client_estimated_hop_count"
        ],
        "additionalProperties": false,
        "properties": {
          "listing": {
            "type": "string"
          },
          "funding_asset": {
            "$ref": "#/components/schemas/CommunityMoneyAssetRef",
            "nullable": true
          },
          "source_chain": {
            "$ref": "#/components/schemas/CommunityMoneyChainRef",
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
        "required": [
          "id",
          "object",
          "community",
          "listing",
          "buyer_user",
          "base_price_cents",
          "final_price_cents",
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
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_purchase_quote"
            ]
          },
          "community": {
            "type": "string"
          },
          "listing": {
            "type": "string"
          },
          "buyer_user": {
            "type": "string"
          },
          "asset": {
            "type": "string",
            "nullable": true
          },
          "live_room": {
            "type": "string",
            "nullable": true
          },
          "replay_asset": {
            "type": "string",
            "nullable": true
          },
          "base_price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "pricing_tier": {
            "type": "string",
            "nullable": true
          },
          "final_price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "settlement_mode": {
            "$ref": "#/components/schemas/CommunityPurchaseSettlementMode"
          },
          "allocation_snapshot": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunitySaleAllocationSnapshot"
            }
          },
          "funding_mode": {
            "$ref": "#/components/schemas/CommunityPurchaseFundingMode"
          },
          "funding_asset": {
            "$ref": "#/components/schemas/CommunityMoneyAssetRef",
            "nullable": true
          },
          "source_chain": {
            "$ref": "#/components/schemas/CommunityMoneyChainRef",
            "nullable": true
          },
          "route_provider": {
            "type": "string",
            "nullable": true
          },
          "route_policy_compliant": {
            "type": "boolean"
          },
          "route_live_available": {
            "type": "boolean",
            "nullable": true
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "destination_settlement_chain": {
            "$ref": "#/components/schemas/CommunityMoneyChainRef"
          },
          "destination_settlement_token": {
            "type": "string"
          },
          "destination_settlement_amount_atomic": {
            "type": "string",
            "nullable": true
          },
          "destination_settlement_decimals": {
            "type": "integer",
            "nullable": true,
            "minimum": 0
          },
          "funding_destination_address": {
            "type": "string",
            "nullable": true
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
            "$ref": "#/components/schemas/CommunityFundingRouteStatusPolicy"
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
            "type": "integer",
            "format": "int64"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "CommunityPurchaseSettlementRequest": {
        "type": "object",
        "required": [
          "quote",
          "settlement_wallet_attachment",
          "funding_tx_ref",
          "settlement_tx_ref"
        ],
        "additionalProperties": false,
        "properties": {
          "quote": {
            "type": "string"
          },
          "settlement_wallet_attachment": {
            "type": "string"
          },
          "funding_tx_ref": {
            "type": "string"
          },
          "settlement_tx_ref": {
            "type": "string"
          }
        }
      },
      "CommunityPurchaseSettlement": {
        "type": "object",
        "required": [
          "id",
          "object",
          "quote",
          "community",
          "listing",
          "buyer_user",
          "settlement_wallet_attachment",
          "purchase_price_cents",
          "settlement_mode",
          "settlement_chain",
          "settlement_chain_ref",
          "settlement_token",
          "settlement_tx_ref",
          "allocations",
          "entitlement_kind",
          "entitlement_target_ref",
          "purchase_entitlement",
          "settled_at"
        ],
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_purchase_settlement"
            ]
          },
          "quote": {
            "type": "string"
          },
          "community": {
            "type": "string"
          },
          "listing": {
            "type": "string"
          },
          "buyer_user": {
            "type": "string"
          },
          "asset": {
            "type": "string",
            "nullable": true
          },
          "live_room": {
            "type": "string",
            "nullable": true
          },
          "replay_asset": {
            "type": "string",
            "nullable": true
          },
          "settlement_wallet_attachment": {
            "type": "string"
          },
          "purchase_price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "pricing_tier": {
            "type": "string",
            "nullable": true
          },
          "settlement_mode": {
            "$ref": "#/components/schemas/CommunityPurchaseSettlementMode"
          },
          "settlement_chain": {
            "$ref": "#/components/schemas/CommunityMoneyChainRef"
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
              "$ref": "#/components/schemas/CommunitySaleAllocationLeg"
            }
          },
          "donation_partner": {
            "type": "string",
            "nullable": true
          },
          "donation_share_bps": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "donation_amount_cents": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "vinyl_release_provider": {
            "type": "string",
            "enum": [
              "elasticstage"
            ],
            "nullable": true
          },
          "vinyl_release_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
          },
          "entitlement_kind": {
            "type": "string",
            "enum": [
              "asset_access",
              "live_room_access",
              "replay_access"
            ]
          },
          "entitlement_target_ref": {
            "type": "string"
          },
          "purchase_entitlement": {
            "type": "string"
          },
          "settled_at": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "CommunityPurchaseSettlementFailureRequest": {
        "type": "object",
        "required": [
          "quote"
        ],
        "additionalProperties": false,
        "properties": {
          "quote": {
            "type": "string"
          }
        }
      },
      "CommunityPurchaseSettlementFailure": {
        "type": "object",
        "required": [
          "id",
          "object",
          "quote",
          "community",
          "status",
          "expires_at"
        ],
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_purchase_settlement_failure"
            ]
          },
          "quote": {
            "type": "string"
          },
          "community": {
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "expires_at": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "MembershipResult": {
        "type": "object",
        "required": [
          "community",
          "status"
        ],
        "properties": {
          "community": {
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
              "$ref": "#/components/schemas/MembershipRequestSummary"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "MembershipRequestSummary": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "applicant_user",
          "status",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "membership_request_summary"
            ]
          },
          "community": {
            "type": "string"
          },
          "applicant_user": {
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
            "$ref": "#/components/schemas/MembershipRequestStatus"
          },
          "note": {
            "type": "string",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "CommunityFollowResponse": {
        "type": "object",
        "required": [
          "community",
          "following"
        ],
        "properties": {
          "community": {
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
      "CommunityPreview": {
        "type": "object",
        "required": [
          "id",
          "object",
          "display_name",
          "membership_mode",
          "human_verification_lane",
          "moderators",
          "membership_gate_summaries",
          "rules",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_preview"
            ]
          },
          "namespace_verification": {
            "type": "string",
            "nullable": true
          },
          "route_slug": {
            "type": "string",
            "nullable": true
          },
          "display_name": {
            "type": "string"
          },
          "localized_text": {
            "$ref": "#/components/schemas/CommunityTextLocalization",
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
          "store_url": {
            "type": "string",
            "nullable": true
          },
          "store_label": {
            "type": "string",
            "nullable": true
          },
          "country_code": {
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
          "karaoke_enabled": {
            "type": "boolean"
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
          "guest_comment_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "altcha_required"
            ]
          },
          "agent_posting_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "review",
              "allow_with_disclosure",
              "allow"
            ]
          },
          "agent_posting_scope": {
            "type": "string",
            "enum": [
              "replies_only",
              "top_level_and_replies"
            ]
          },
          "agent_daily_post_cap": {
            "type": "integer",
            "nullable": true
          },
          "agent_daily_reply_cap": {
            "type": "integer",
            "nullable": true
          },
          "accepted_agent_ownership_providers": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/AgentOwnershipProvider"
            }
          },
          "human_verification_lane": {
            "$ref": "#/components/schemas/HumanVerificationLane"
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
          "donation_partner": {
            "$ref": "#/components/schemas/DonationPartnerSummary",
            "nullable": true
          },
          "owner": {
            "$ref": "#/components/schemas/CommunityRoleSummary",
            "nullable": true
          },
          "moderators": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityRoleSummary"
            }
          },
          "reference_links": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "#/components/schemas/CommunityReferenceLinkPublic"
            }
          },
          "membership_gate_summaries": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/MembershipGateSummary"
            }
          },
          "gate_match_mode": {
            "type": "string",
            "enum": [
              "all",
              "any"
            ],
            "nullable": true
          },
          "rules": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityRule"
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
          "viewer_community_role": {
            "type": "string",
            "enum": [
              "owner",
              "admin",
              "moderator"
            ],
            "nullable": true
          },
          "viewer_following": {
            "type": "boolean",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "JoinEligibility": {
        "type": "object",
        "required": [
          "community",
          "membership_mode",
          "human_verification_lane",
          "joinable_now",
          "status",
          "membership_gate_summaries"
        ],
        "properties": {
          "community": {
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
            "$ref": "#/components/schemas/HumanVerificationLane"
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
              "$ref": "#/components/schemas/MembershipGateSummary"
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
                "wallet_score",
                "altcha_pow"
              ]
            }
          },
          "suggested_verification_provider": {
            "type": "string",
            "enum": [
              "self",
              "zkpassport",
              "very",
              "passport"
            ],
            "nullable": true
          },
          "suggested_verification_intent": {
            "type": "string",
            "enum": [
              "community_join",
              "post_create",
              "comment_create"
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
            "properties": {
              "current_score_decimal": {
                "type": "string",
                "pattern": "^\\d+(\\.\\d+)?$",
                "nullable": true
              },
              "required_score_decimal": {
                "type": "string",
                "pattern": "^\\d+(\\.\\d+)?$",
                "nullable": true
              },
              "passing_score": {
                "type": "boolean",
                "nullable": true
              },
              "last_scored_at": {
                "type": "integer",
                "nullable": true
              }
            }
          },
          "gate_evaluation": {
            "$ref": "#/components/schemas/GatePolicyEvaluation",
            "nullable": true
          }
        }
      },
      "LiveRoomRecordingDraft": {
        "type": "object",
        "required": [
          "object",
          "live_room",
          "recording_enabled",
          "replay_status",
          "status",
          "replay_asset",
          "recording"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "live_room_replay_draft"
            ]
          },
          "live_room": {
            "type": "string"
          },
          "recording_enabled": {
            "type": "boolean"
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
          "status": {
            "type": "string",
            "enum": [
              "not_recorded",
              "processing",
              "ready",
              "published",
              "failed"
            ]
          },
          "replay_asset": {
            "nullable": true,
            "$ref": "#/components/schemas/LiveRoomReplayAsset"
          },
          "recording": {
            "nullable": true,
            "$ref": "#/components/schemas/LiveRoomRecording"
          }
        }
      },
      "UpdateLiveRoomReplayDraftRequest": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "nullable": true
          },
          "caption": {
            "type": "string",
            "nullable": true
          },
          "preview_ref": {
            "type": "string",
            "nullable": true
          },
          "access_mode": {
            "type": "string",
            "nullable": true,
            "enum": [
              "free",
              "included_with_ticket",
              "paid"
            ]
          },
          "allocations": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "#/components/schemas/UpdateLiveRoomReplayAllocation"
            }
          }
        }
      },
      "PublishLiveRoomReplayDraftRequest": {
        "type": "object",
        "properties": {
          "access_mode": {
            "type": "string",
            "enum": [
              "free",
              "included_with_ticket",
              "paid"
            ]
          },
          "listing": {
            "nullable": true,
            "$ref": "#/components/schemas/CreateCommunityListingRequest"
          }
        }
      },
      "LiveRoomReplayAccessDecision": {
        "type": "object",
        "required": [
          "live_room",
          "replay_asset",
          "replay_status",
          "access_mode",
          "locked_delivery_status",
          "access_granted",
          "decision_reason",
          "delivery_kind",
          "delivery_ref",
          "story_cdr_access"
        ],
        "properties": {
          "live_room": {
            "type": "string"
          },
          "replay_asset": {
            "type": "string",
            "nullable": true
          },
          "replay_listing": {
            "nullable": true,
            "$ref": "#/components/schemas/CommunityListing"
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
          "access_mode": {
            "type": "string",
            "enum": [
              "free",
              "included_with_ticket",
              "paid"
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
              "free",
              "creator",
              "moderator",
              "purchase_entitlement",
              "purchase_required",
              "delivery_pending",
              "not_published",
              "not_available"
            ]
          },
          "delivery_kind": {
            "type": "string",
            "nullable": true,
            "enum": [
              "primary_content_ref",
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
            "additionalProperties": true
          }
        }
      },
      "CreatePostRequest": {
        "type": "object",
        "oneOf": [
          {
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
                    "song_artifact_bundle"
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
                  "$ref": "#/components/schemas/ImageMediaDescriptor"
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
                    "song_artifact_bundle"
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
              "royalty_allocations": {
                "type": "array",
                "maxItems": 10,
                "nullable": true,
                "items": {
                  "$ref": "#/components/schemas/RoyaltyAllocationRequest"
                }
              },
              "media_refs": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "#/components/schemas/VideoMediaDescriptor"
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
                    "song_artifact_bundle"
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
                    "song_artifact_bundle"
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
            "required": [
              "post_type",
              "identity_mode"
            ],
            "anyOf": [
              {
                "required": [
                  "song_artifact_bundle"
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
              "royalty_allocations": {
                "type": "array",
                "maxItems": 10,
                "nullable": true,
                "items": {
                  "$ref": "#/components/schemas/RoyaltyAllocationRequest"
                }
              },
              "title": {
                "type": "string",
                "nullable": true
              },
              "media_refs": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "$ref": "#/components/schemas/AudioMediaDescriptor"
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
                        "song_artifact_bundle"
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
                      "required": null
                    },
                    "song_artifact_bundle",
                    {
                      "required": [
                        "lyrics"
                      ]
                    }
                  ]
                }
              ]
            }
          },
          {
            "required": [
              "post_type",
              "title",
              "source_post",
              "source_community"
            ],
            "properties": {
              "post_type": {
                "type": "string",
                "enum": [
                  "crosspost"
                ]
              },
              "title": {
                "type": "string"
              },
              "source_post": {
                "type": "string"
              },
              "source_community": {
                "type": "string"
              }
            }
          }
        ],
        "required": [
          "idempotency_key",
          "post_type"
        ],
        "properties": {
          "idempotency_key": {
            "type": "string"
          },
          "publish_mode": {
            "type": "string",
            "enum": [
              "sync",
              "async"
            ],
            "default": "sync"
          },
          "listing_draft": {
            "$ref": "#/components/schemas/CreatePostListingDraft",
            "nullable": true
          },
          "authorship_mode": {
            "type": "string",
            "enum": [
              "human_direct",
              "user_agent"
            ],
            "default": "human_direct"
          },
          "agent": {
            "type": "string",
            "nullable": true
          },
          "agent_action_proof": {
            "$ref": "#/components/schemas/AgentActionProof",
            "nullable": true
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
            "nullable": true
          },
          "disclosed_qualifier_ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "nullable": true
          },
          "parent_post": {
            "type": "string",
            "nullable": true
          },
          "label": {
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
              "song",
              "crosspost"
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
            "nullable": true
          },
          "source_post": {
            "type": "string",
            "nullable": true
          },
          "source_community": {
            "type": "string",
            "nullable": true
          },
          "media_refs": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/MediaDescriptor"
            }
          },
          "creator_relation": {
            "$ref": "#/components/schemas/PostCreatorRelation",
            "nullable": true
          },
          "promotion_disclosure": {
            "$ref": "#/components/schemas/PromotionDisclosureInput",
            "nullable": true
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
            "enum": [
              "public",
              "locked"
            ],
            "nullable": true
          },
          "asset": {
            "type": "string",
            "nullable": true
          },
          "song_artifact_bundle": {
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
            "nullable": true
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
          "lyrics": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "Post": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "authorship_mode",
          "identity_mode",
          "post_type",
          "status",
          "visibility",
          "analysis_state",
          "content_safety_state",
          "age_gate_policy",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "post"
            ]
          },
          "community": {
            "type": "string"
          },
          "author_user": {
            "type": "string",
            "nullable": true
          },
          "author_public_handle": {
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
          "agent": {
            "type": "string",
            "nullable": true
          },
          "agent_ownership_record": {
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
            "type": "string",
            "nullable": true
          },
          "disclosed_qualifiers_json": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/DisclosedQualifierSnapshot"
            },
            "nullable": true
          },
          "label": {
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
              "song",
              "crosspost"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "processing",
              "published",
              "failed",
              "hidden",
              "removed",
              "deleted"
            ]
          },
          "comments_locked": {
            "type": "boolean"
          },
          "comments_locked_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "comments_locked_by_user": {
            "type": "string",
            "nullable": true
          },
          "comments_lock_reason": {
            "type": "string",
            "nullable": true
          },
          "visibility": {
            "type": "string",
            "enum": [
              "public",
              "members_only"
            ]
          },
          "publish_failure_code": {
            "$ref": "#/components/schemas/PostPublishFailureCode",
            "nullable": true
          },
          "publish_failure_message": {
            "type": "string",
            "nullable": true
          },
          "publish_failure_retryable": {
            "type": "boolean",
            "nullable": true
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
          "link_enrichment": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          },
          "embeds": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/PostEmbed"
            },
            "nullable": true
          },
          "media_refs": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/MediaDescriptor"
            }
          },
          "creator_relation": {
            "$ref": "#/components/schemas/PostCreatorRelation",
            "nullable": true
          },
          "promotion_disclosure": {
            "$ref": "#/components/schemas/PromotionDisclosure",
            "nullable": true
          },
          "source_language": {
            "type": "string",
            "nullable": true
          },
          "source_language_confidence": {
            "type": "number",
            "format": "double",
            "nullable": true,
            "minimum": 0,
            "maximum": 1
          },
          "source_language_reliable": {
            "type": "boolean"
          },
          "source_language_detector": {
            "type": "string",
            "nullable": true
          },
          "source_language_detected_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "source_language_source_hash": {
            "type": "string",
            "nullable": true
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
            "enum": [
              "public",
              "locked"
            ],
            "nullable": true
          },
          "asset": {
            "type": "string",
            "nullable": true
          },
          "song_artifact_bundle": {
            "type": "string",
            "nullable": true
          },
          "crosspost_source": {
            "$ref": "#/components/schemas/CrosspostSource",
            "nullable": true
          },
          "anchor_live_room": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "anchor_live_room_status": {
            "type": "string",
            "enum": [
              "scheduled",
              "live",
              "ended",
              "canceled"
            ],
            "nullable": true,
            "readOnly": true
          },
          "song_title": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "song_annotations_url": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "parent_post": {
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
            "nullable": true
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
          "created": {
            "type": "integer",
            "format": "int64"
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
              "$ref": "#/components/schemas/FeedItem"
            }
          },
          "top_communities": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/HomeFeedCommunitySummary"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
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
              "$ref": "#/components/schemas/CommentListItem"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          },
          "thread_snapshot": {
            "$ref": "#/components/schemas/CommentThreadSnapshot",
            "nullable": true
          }
        }
      },
      "CreateCommentRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "idempotency_key": {
            "type": "string",
            "nullable": true
          },
          "body": {
            "type": "string"
          },
          "media_refs": {
            "type": "array",
            "maxItems": 1,
            "items": {
              "$ref": "#/components/schemas/MediaDescriptor"
            }
          },
          "authorship_mode": {
            "type": "string",
            "enum": [
              "human_direct",
              "user_agent",
              "guest"
            ],
            "default": "human_direct"
          },
          "agent": {
            "type": "string",
            "nullable": true
          },
          "agent_action_proof": {
            "$ref": "#/components/schemas/AgentActionProof",
            "nullable": true
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
      "Comment": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "object",
          "community",
          "thread_root_post",
          "parent_comment",
          "author_user",
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
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "comment"
            ]
          },
          "community": {
            "type": "string"
          },
          "thread_root_post": {
            "type": "string"
          },
          "parent_comment": {
            "type": "string",
            "nullable": true
          },
          "author_user": {
            "type": "string",
            "nullable": true
          },
          "author_public_handle": {
            "type": "string",
            "nullable": true
          },
          "authorship_mode": {
            "type": "string",
            "enum": [
              "human_direct",
              "user_agent",
              "guest"
            ]
          },
          "agent": {
            "type": "string",
            "nullable": true
          },
          "agent_ownership_record": {
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
            "$ref": "#/components/schemas/AgentOwnershipProvider",
            "nullable": true
          },
          "body": {
            "type": "string",
            "nullable": true
          },
          "media_refs": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/MediaDescriptor"
            }
          },
          "source_language": {
            "type": "string",
            "nullable": true
          },
          "source_language_confidence": {
            "type": "number",
            "format": "double",
            "nullable": true,
            "minimum": 0,
            "maximum": 1
          },
          "source_language_reliable": {
            "type": "boolean"
          },
          "source_language_detector": {
            "type": "string",
            "nullable": true
          },
          "source_language_detected_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "source_language_source_hash": {
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
          "replies_locked": {
            "type": "boolean"
          },
          "replies_locked_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "replies_locked_by_user": {
            "type": "string",
            "nullable": true
          },
          "replies_lock_reason": {
            "type": "string",
            "nullable": true
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
            "type": "integer",
            "format": "int64",
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
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "CommentLockRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "locked": {
            "type": "boolean",
            "default": true
          },
          "reason": {
            "type": "string",
            "nullable": true
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
            "$ref": "#/components/schemas/UserReportReasonCode"
          },
          "note": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "UserReport": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "post",
          "comment",
          "reporter_user",
          "reason_code",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "user_report"
            ]
          },
          "community": {
            "type": "string"
          },
          "post": {
            "type": "string",
            "nullable": true
          },
          "comment": {
            "type": "string",
            "nullable": true
          },
          "reporter_user": {
            "type": "string"
          },
          "reason_code": {
            "$ref": "#/components/schemas/UserReportReasonCode"
          },
          "note": {
            "type": "string",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "KaraokeSession": {
        "type": "object",
        "required": [
          "id",
          "object",
          "attempt",
          "protocol_version",
          "websocket_url",
          "token_expires_at",
          "session_expires_at",
          "scoring_policy"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "karaoke_session"
            ]
          },
          "attempt": {
            "type": "string"
          },
          "protocol_version": {
            "type": "integer",
            "enum": [
              1
            ]
          },
          "websocket_url": {
            "type": "string"
          },
          "token_expires_at": {
            "type": "integer"
          },
          "session_expires_at": {
            "type": "integer"
          },
          "scoring_policy": {
            "$ref": "#/components/schemas/KaraokeScoringPolicy"
          }
        }
      },
      "SongStudyPayload": {
        "type": "object",
        "required": [
          "object",
          "post_id",
          "community_id",
          "access",
          "title",
          "exercise_count",
          "exercises"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "song_study_payload"
            ]
          },
          "post_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "access": {
            "$ref": "#/components/schemas/SongStudyAccessState"
          },
          "title": {
            "type": "string"
          },
          "artist_name": {
            "type": "string",
            "nullable": true
          },
          "artwork_src": {
            "type": "string",
            "nullable": true
          },
          "source_language": {
            "type": "string",
            "nullable": true
          },
          "target_language": {
            "type": "string",
            "nullable": true
          },
          "exercise_count": {
            "type": "integer"
          },
          "exercises": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/SongStudyExercise"
            }
          },
          "session": {
            "$ref": "#/components/schemas/SongStudySessionSummary"
          },
          "study_pack_version": {
            "type": "integer"
          },
          "generated_at": {
            "type": "integer",
            "format": "int64"
          },
          "locked_reason": {
            "$ref": "#/components/schemas/SongStudyLockedReason"
          },
          "unavailable_reason": {
            "$ref": "#/components/schemas/SongStudyUnavailableReason"
          }
        },
        "additionalProperties": false
      },
      "SongStudyAttemptRequest": {
        "type": "object",
        "required": [
          "idempotency_key",
          "exercise_id",
          "type",
          "attempt_number"
        ],
        "properties": {
          "idempotency_key": {
            "type": "string"
          },
          "exercise_id": {
            "type": "string"
          },
          "type": {
            "type": "string",
            "enum": [
              "say_it_back",
              "translation_choice"
            ]
          },
          "attempt_number": {
            "type": "integer"
          },
          "selected_option_id": {
            "type": "string"
          },
          "transcript": {
            "type": "string"
          }
        },
        "additionalProperties": false
      },
      "SongStudyAttemptResult": {
        "type": "object",
        "required": [
          "object",
          "exercise_id",
          "outcome",
          "attempts_remaining"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "song_study_attempt_result"
            ]
          },
          "exercise_id": {
            "type": "string"
          },
          "outcome": {
            "type": "string",
            "enum": [
              "correct",
              "incorrect",
              "revealed"
            ]
          },
          "attempts_remaining": {
            "type": "integer"
          },
          "correct_option_id": {
            "type": "string"
          },
          "feedback": {
            "type": "object",
            "properties": {
              "matched": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "missing": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "extra": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "additionalProperties": false
          },
          "next_review_hint": {
            "type": "string",
            "enum": [
              "again",
              "hard",
              "good",
              "easy"
            ]
          }
        },
        "additionalProperties": false
      },
      "SongStudyTranscriptionResponse": {
        "type": "object",
        "required": [
          "object",
          "provider",
          "model",
          "text"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "song_study_transcription"
            ]
          },
          "provider": {
            "type": "string",
            "enum": [
              "elevenlabs"
            ]
          },
          "model": {
            "type": "string"
          },
          "text": {
            "type": "string"
          },
          "confidence": {
            "type": "number",
            "nullable": true
          },
          "language_code": {
            "type": "string",
            "nullable": true
          },
          "language_probability": {
            "type": "number",
            "nullable": true
          },
          "duration_seconds": {
            "type": "number",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "SongStreakLeaderboard": {
        "type": "object",
        "required": [
          "object",
          "post_id",
          "community_id",
          "date",
          "entries",
          "viewer",
          "total_active_streaks"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "song_streak_leaderboard"
            ]
          },
          "post_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "date": {
            "type": "string"
          },
          "entries": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/SongStreakLeaderboardEntry"
            }
          },
          "viewer": {
            "nullable": true,
            "oneOf": [
              {
                "$ref": "#/components/schemas/SongStreakViewerStanding"
              }
            ]
          },
          "total_active_streaks": {
            "type": "integer"
          }
        },
        "additionalProperties": false
      },
      "ModerationCaseListResponse": {
        "type": "object",
        "required": [
          "items",
          "next_cursor"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/ModerationCaseListItem"
            }
          },
          "next_cursor": {
            "type": "string",
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
            "$ref": "#/components/schemas/ModerationCase"
          },
          "post": {
            "$ref": "#/components/schemas/Post",
            "nullable": true
          },
          "comment": {
            "$ref": "#/components/schemas/Comment",
            "nullable": true
          },
          "signals": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/ModerationSignal"
            }
          },
          "reports": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/UserReport"
            }
          },
          "actions": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/ModerationAction"
            }
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
            "$ref": "#/components/schemas/ModerationActionType"
          },
          "note": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "RightsReviewCaseListResponse": {
        "type": "object",
        "required": [
          "items",
          "next_cursor"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/RightsReviewCaseListItem"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "RightsReviewCaseDetail": {
        "type": "object",
        "required": [
          "case",
          "analysis",
          "post"
        ],
        "properties": {
          "case": {
            "$ref": "#/components/schemas/RightsReviewCase"
          },
          "analysis": {
            "$ref": "#/components/schemas/MediaAnalysisResult",
            "nullable": true
          },
          "post": {
            "$ref": "#/components/schemas/Post",
            "nullable": true
          }
        }
      },
      "CreateRightsReviewActionRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "action_type"
        ],
        "properties": {
          "action_type": {
            "type": "string",
            "enum": [
              "start_review",
              "clear",
              "clear_with_upstream_refs",
              "needs_more_evidence",
              "block"
            ]
          },
          "evidence_refs": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
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
              "preview_video",
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
          },
          "upload_mode": {
            "type": "string",
            "nullable": true,
            "enum": [
              "proxy",
              "direct_multipart"
            ]
          }
        }
      },
      "SongArtifactUpload": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "uploader_user",
          "artifact_kind",
          "status",
          "storage_ref",
          "mime_type",
          "upload_url",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "song_artifact_upload"
            ]
          },
          "community": {
            "type": "string"
          },
          "uploader_user": {
            "type": "string"
          },
          "artifact_kind": {
            "type": "string",
            "enum": [
              "primary_audio",
              "cover_art",
              "preview_audio",
              "preview_video",
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
              "failed",
              "cancelled"
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
          "ipfs_cid": {
            "type": "string",
            "nullable": true
          },
          "upload_url": {
            "type": "string"
          },
          "upload_session": {
            "type": "object",
            "nullable": true,
            "additionalProperties": false,
            "required": [
              "id",
              "status",
              "object_key",
              "upload_id",
              "part_size_bytes",
              "total_parts",
              "expires_at",
              "sign_part_url",
              "complete",
              "abort"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "status": {
                "type": "string",
                "enum": [
                  "created",
                  "parts_uploading",
                  "completing",
                  "head_verifying",
                  "uploaded",
                  "aborting",
                  "aborted"
                ]
              },
              "object_key": {
                "type": "string"
              },
              "upload_id": {
                "type": "string"
              },
              "part_size_bytes": {
                "type": "integer"
              },
              "total_parts": {
                "type": "integer"
              },
              "expires_at": {
                "type": "string"
              },
              "sign_part_url": {
                "type": "string"
              },
              "complete": {
                "type": "string"
              },
              "abort": {
                "type": "string"
              }
            }
          },
          "created": {
            "type": "integer",
            "format": "int64"
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
      "SongArtifactBundleListResponse": {
        "type": "object",
        "required": [
          "items",
          "next_cursor"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/SongArtifactBundle"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CreateSongArtifactBundleRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "primary_audio",
          "title",
          "lyrics"
        ],
        "properties": {
          "primary_audio": {
            "$ref": "#/components/schemas/SongArtifactUploadRef"
          },
          "title": {
            "type": "string"
          },
          "lyrics": {
            "type": "string"
          },
          "analysis_mode": {
            "type": "string",
            "enum": [
              "sync",
              "deferred"
            ],
            "default": "sync"
          },
          "genius_annotations_url": {
            "type": "string",
            "nullable": true
          },
          "cover_art": {
            "$ref": "#/components/schemas/SongArtifactUploadRef",
            "nullable": true
          },
          "preview_audio": {
            "$ref": "#/components/schemas/SongArtifactUploadRef",
            "nullable": true
          },
          "preview_window": {
            "$ref": "#/components/schemas/SongPreviewWindow",
            "nullable": true
          },
          "canvas_video": {
            "$ref": "#/components/schemas/SongArtifactUploadRef",
            "nullable": true
          },
          "instrumental_audio": {
            "$ref": "#/components/schemas/SongArtifactUploadRef",
            "nullable": true
          },
          "vocal_audio": {
            "$ref": "#/components/schemas/SongArtifactUploadRef",
            "nullable": true
          }
        }
      },
      "SongArtifactBundle": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "creator_user",
          "status",
          "title",
          "primary_audio",
          "media_refs",
          "lyrics",
          "lyrics_sha256",
          "preview_status",
          "translation_status",
          "alignment_status",
          "moderation_status",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "song_artifact_bundle"
            ]
          },
          "community": {
            "type": "string"
          },
          "creator_user": {
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
          "title": {
            "type": "string"
          },
          "primary_audio": {
            "$ref": "#/components/schemas/SongAudioArtifactDescriptor"
          },
          "media_refs": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/MediaDescriptor"
            }
          },
          "lyrics": {
            "type": "string"
          },
          "lyrics_sha256": {
            "type": "string"
          },
          "genius_annotations_url": {
            "type": "string",
            "nullable": true
          },
          "cover_art": {
            "$ref": "#/components/schemas/SongImageArtifactDescriptor",
            "nullable": true
          },
          "preview_audio": {
            "$ref": "#/components/schemas/SongAudioArtifactDescriptor",
            "nullable": true
          },
          "preview_window": {
            "$ref": "#/components/schemas/SongPreviewWindow",
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
            "$ref": "#/components/schemas/SongVideoArtifactDescriptor",
            "nullable": true
          },
          "instrumental_audio": {
            "$ref": "#/components/schemas/SongAudioArtifactDescriptor",
            "nullable": true
          },
          "vocal_audio": {
            "$ref": "#/components/schemas/SongAudioArtifactDescriptor",
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
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "Booking": {
        "type": "object",
        "additionalProperties": true,
        "required": [
          "booking_id",
          "host_user_id",
          "booker_user_id",
          "slot_start_utc",
          "slot_end_utc",
          "gross_cents",
          "platform_fee_cents",
          "host_payout_cents",
          "status"
        ],
        "properties": {
          "booking_id": {
            "type": "string"
          },
          "status": {
            "$ref": "#/BookingStatus"
          },
          "host_user_id": {
            "type": "string"
          },
          "booker_user_id": {
            "type": "string"
          },
          "slot_start_utc": {
            "type": "string",
            "format": "date-time"
          },
          "slot_end_utc": {
            "type": "string",
            "format": "date-time"
          },
          "gross_cents": {
            "type": "integer"
          },
          "platform_fee_cents": {
            "type": "integer"
          },
          "host_payout_cents": {
            "type": "integer"
          }
        }
      },
      "BookingSlotsResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "host_timezone",
          "viewer_timezone",
          "slots"
        ],
        "properties": {
          "host_timezone": {
            "type": "string"
          },
          "viewer_timezone": {
            "type": "string"
          },
          "slots": {
            "type": "array",
            "items": {
              "$ref": "#/ResolvedBookingSlot"
            }
          }
        }
      },
      "CreateBookingHoldRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "slot_start_utc",
          "slot_end_utc"
        ],
        "properties": {
          "slot_start_utc": {
            "type": "string",
            "format": "date-time"
          },
          "slot_end_utc": {
            "type": "string",
            "format": "date-time"
          },
          "source_community_id": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "BookingHold": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "hold_id": {
            "type": "string"
          }
        }
      },
      "BookingQuote": {
        "type": "object",
        "additionalProperties": true,
        "required": [
          "hold_id",
          "gross_cents",
          "platform_fee_bps",
          "platform_fee_cents",
          "host_payout_cents",
          "expires_at_utc",
          "payment"
        ],
        "properties": {
          "hold_id": {
            "type": "string"
          },
          "gross_cents": {
            "type": "integer"
          },
          "platform_fee_bps": {
            "type": "integer"
          },
          "platform_fee_cents": {
            "type": "integer"
          },
          "host_payout_cents": {
            "type": "integer"
          },
          "expires_at_utc": {
            "type": "string",
            "format": "date-time"
          },
          "payment": {
            "$ref": "#/BookingPaymentInstructions"
          }
        }
      },
      "ConfirmBookingHoldRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "funding_tx_ref",
          "wallet_attachment_id"
        ],
        "properties": {
          "funding_tx_ref": {
            "type": "string"
          },
          "wallet_attachment_id": {
            "type": "string"
          }
        }
      },
      "ResolveBookingSettlementReviewRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "resolution",
          "expected_review_version"
        ],
        "properties": {
          "resolution": {
            "type": "string",
            "enum": [
              "completed",
              "no_show_host",
              "no_show_booker"
            ]
          },
          "expected_review_version": {
            "type": "integer",
            "minimum": 0
          },
          "note": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "ResolveBookingSettlementReviewResponse": {
        "type": "object",
        "additionalProperties": true,
        "required": [
          "booking",
          "resolution",
          "pending_settlement",
          "replayed"
        ],
        "properties": {
          "booking": {
            "$ref": "#/Booking"
          },
          "resolution": {
            "type": "string",
            "enum": [
              "completed",
              "no_show_host",
              "no_show_booker"
            ]
          },
          "pending_settlement": {
            "type": "boolean"
          },
          "replayed": {
            "type": "boolean"
          }
        }
      },
      "BookingSessionAttachResponse": {
        "type": "object",
        "additionalProperties": true,
        "required": [
          "session_id",
          "party",
          "channel",
          "agora"
        ],
        "properties": {
          "session_id": {
            "type": "string"
          },
          "party": {
            "type": "string",
            "enum": [
              "host",
              "booker"
            ]
          },
          "channel": {
            "type": "string"
          },
          "agora": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          }
        }
      },
      "BookingProfileResponse": {
        "oneOf": [
          {
            "$ref": "#/BookingProfile"
          },
          {
            "$ref": "#/BookingProfileEmpty"
          }
        ]
      },
      "UpdateBookingProfileRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "host_timezone": {
            "type": "string"
          },
          "base_price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "default_slot_duration_seconds": {
            "type": "integer",
            "minimum": 60
          },
          "display_headline": {
            "type": "string",
            "nullable": true
          },
          "bio": {
            "type": "string",
            "nullable": true
          },
          "topics": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
          },
          "intro_video_ref": {
            "type": "string",
            "nullable": true
          },
          "platform_fee_bps": {
            "type": "integer",
            "minimum": 0
          },
          "payout_wallet_address": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "BookingProfile": {
        "type": "object",
        "additionalProperties": true,
        "required": [
          "object",
          "host",
          "host_timezone",
          "base_price_cents",
          "default_slot_duration_seconds",
          "platform_fee_bps",
          "is_published",
          "created",
          "updated"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "booking_profile"
            ]
          },
          "host": {
            "type": "string"
          },
          "display_headline": {
            "type": "string",
            "nullable": true
          },
          "bio": {
            "type": "string",
            "nullable": true
          },
          "topics": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
          },
          "intro_video_ref": {
            "type": "string",
            "nullable": true
          },
          "host_timezone": {
            "type": "string"
          },
          "base_price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "default_slot_duration_seconds": {
            "type": "integer",
            "minimum": 60
          },
          "platform_fee_bps": {
            "type": "integer",
            "minimum": 0
          },
          "payout_wallet_address": {
            "type": "string",
            "nullable": true
          },
          "is_published": {
            "type": "boolean"
          },
          "created": {
            "type": "integer"
          },
          "updated": {
            "type": "integer"
          }
        }
      },
      "AvailabilityRule": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "object",
          "id",
          "by_weekday",
          "start_local",
          "end_local",
          "slot_duration_seconds",
          "effective_from",
          "effective_until",
          "created",
          "updated"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "availability_rule"
            ]
          },
          "id": {
            "type": "string"
          },
          "by_weekday": {
            "type": "array",
            "items": {
              "type": "integer",
              "minimum": 0,
              "maximum": 6
            }
          },
          "start_local": {
            "type": "string"
          },
          "end_local": {
            "type": "string"
          },
          "slot_duration_seconds": {
            "type": "integer",
            "minimum": 60
          },
          "effective_from": {
            "type": "integer",
            "nullable": true
          },
          "effective_until": {
            "type": "integer",
            "nullable": true
          },
          "created": {
            "type": "integer"
          },
          "updated": {
            "type": "integer"
          }
        }
      },
      "CreateAvailabilityRuleRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "by_weekday",
          "start_local",
          "end_local",
          "slot_duration_seconds"
        ],
        "properties": {
          "by_weekday": {
            "type": "array",
            "items": {
              "type": "integer",
              "minimum": 0,
              "maximum": 6
            }
          },
          "start_local": {
            "type": "string"
          },
          "end_local": {
            "type": "string"
          },
          "slot_duration_seconds": {
            "type": "integer",
            "minimum": 60
          },
          "effective_from_utc": {
            "type": "string",
            "format": "date-time"
          },
          "effective_until_utc": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "UpdateAvailabilityRuleRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "by_weekday": {
            "type": "array",
            "items": {
              "type": "integer",
              "minimum": 0,
              "maximum": 6
            }
          },
          "start_local": {
            "type": "string"
          },
          "end_local": {
            "type": "string"
          },
          "slot_duration_seconds": {
            "type": "integer",
            "minimum": 60
          },
          "effective_from_utc": {
            "type": "string",
            "format": "date-time"
          },
          "effective_until_utc": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "AvailabilityException": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "object",
          "id",
          "kind",
          "start",
          "end",
          "created"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "availability_exception"
            ]
          },
          "id": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "block",
              "open"
            ]
          },
          "start": {
            "type": "integer"
          },
          "end": {
            "type": "integer"
          },
          "created": {
            "type": "integer"
          }
        }
      },
      "CreateAvailabilityExceptionRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "start_utc",
          "end_utc"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "block",
              "open"
            ]
          },
          "start_utc": {
            "type": "string",
            "format": "date-time"
          },
          "end_utc": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "UpdateAvailabilityExceptionRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "block",
              "open"
            ]
          },
          "start_utc": {
            "type": "string",
            "format": "date-time"
          },
          "end_utc": {
            "type": "string",
            "format": "date-time"
          }
        }
      },
      "PriceRule": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "object",
          "id",
          "match_weekday",
          "match_local_start",
          "match_local_end",
          "match_duration_seconds",
          "price_cents",
          "priority",
          "created",
          "updated"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "price_rule"
            ]
          },
          "id": {
            "type": "string"
          },
          "match_weekday": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "integer",
              "minimum": 0,
              "maximum": 6
            }
          },
          "match_local_start": {
            "type": "string",
            "nullable": true
          },
          "match_local_end": {
            "type": "string",
            "nullable": true
          },
          "match_duration_seconds": {
            "type": "integer",
            "nullable": true,
            "minimum": 60
          },
          "price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "priority": {
            "type": "integer"
          },
          "created": {
            "type": "integer"
          },
          "updated": {
            "type": "integer"
          }
        }
      },
      "CreatePriceRuleRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "price_cents"
        ],
        "properties": {
          "match_weekday": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "integer",
              "minimum": 0,
              "maximum": 6
            }
          },
          "match_local_start": {
            "type": "string",
            "nullable": true
          },
          "match_local_end": {
            "type": "string",
            "nullable": true
          },
          "match_duration_seconds": {
            "type": "integer",
            "nullable": true,
            "minimum": 60
          },
          "price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "priority": {
            "type": "integer"
          }
        }
      },
      "UpdatePriceRuleRequest": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "match_weekday": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "integer",
              "minimum": 0,
              "maximum": 6
            }
          },
          "match_local_start": {
            "type": "string",
            "nullable": true
          },
          "match_local_end": {
            "type": "string",
            "nullable": true
          },
          "match_duration_seconds": {
            "type": "integer",
            "nullable": true,
            "minimum": 60
          },
          "price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "priority": {
            "type": "integer"
          }
        }
      },
      "LocalizedPostResponse": {
        "type": "object",
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
            "$ref": "#/components/schemas/Post"
          },
          "community": {
            "$ref": "#/components/schemas/CommunityPreview",
            "nullable": true
          },
          "viewer_gate_state": {
            "$ref": "#/components/schemas/PostViewerGateState",
            "nullable": true
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
            "$ref": "#/components/schemas/CommentThreadSnapshot",
            "nullable": true
          },
          "market_context": {
            "$ref": "#/components/schemas/MarketContextSummary",
            "nullable": true
          },
          "label": {
            "$ref": "#/components/schemas/PostLabel",
            "nullable": true
          },
          "song_presentation": {
            "$ref": "#/components/schemas/SongPresentation",
            "nullable": true
          },
          "study_capability": {
            "$ref": "#/components/schemas/SongStudyCapability",
            "nullable": true
          },
          "streak_summary": {
            "$ref": "#/components/schemas/SongStreakSummary",
            "nullable": true
          },
          "asset_story": {
            "$ref": "#/components/schemas/PostAssetStorySummary",
            "nullable": true
          },
          "derivative_sources": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "#/components/schemas/PostDerivativeSource"
            }
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
          "comment_count": {
            "type": "integer",
            "minimum": 0
          },
          "viewer_vote": {
            "type": "integer",
            "enum": [
              -1,
              1
            ],
            "nullable": true
          },
          "viewer_is_author": {
            "type": "boolean"
          },
          "age_gate_viewer_state": {
            "type": "string",
            "enum": [
              "proof_required",
              "verified_allowed"
            ],
            "nullable": true
          },
          "viewer_reaction_kinds": {
            "type": "array",
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
            ]
          },
          "machine_translated": {
            "type": "boolean"
          },
          "translated_body": {
            "type": "string",
            "nullable": true
          },
          "translated_title": {
            "type": "string",
            "nullable": true
          },
          "translated_caption": {
            "type": "string",
            "nullable": true
          },
          "translated_embeds": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "#/components/schemas/LocalizedPostEmbedTranslation"
            }
          },
          "source_hash": {
            "type": "string"
          }
        }
      },
      "PostVoteResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "post",
          "value"
        ],
        "properties": {
          "post": {
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
              "$ref": "#/components/schemas/CommentListItem"
            }
          },
          "comment": {
            "$ref": "#/components/schemas/CommentListItem"
          },
          "replies": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommentListItem"
            }
          },
          "next_replies_cursor": {
            "type": "string",
            "nullable": true
          },
          "thread_snapshot": {
            "$ref": "#/components/schemas/CommentThreadSnapshot",
            "nullable": true
          }
        }
      },
      "CommentVoteResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "comment",
          "value"
        ],
        "properties": {
          "comment": {
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
      "NotificationTasksResponse": {
        "type": "object",
        "required": [
          "items",
          "next_cursor"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/UserTask"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
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
              "$ref": "#/components/schemas/NotificationFeedItem"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
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
      "UserTask": {
        "type": "object",
        "required": [
          "id",
          "object",
          "user",
          "type",
          "subject_type",
          "subject",
          "status",
          "priority",
          "payload",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "user_task"
            ]
          },
          "user": {
            "type": "string"
          },
          "type": {
            "$ref": "#/components/schemas/UserTaskType"
          },
          "subject_type": {
            "type": "string"
          },
          "subject": {
            "type": "string"
          },
          "status": {
            "$ref": "#/components/schemas/UserTaskStatus"
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "dismissed_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "Job": {
        "type": "object",
        "required": [
          "id",
          "object",
          "job_type",
          "status",
          "subject_type",
          "subject",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "job"
            ]
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
          "subject": {
            "type": "string"
          },
          "result_ref": {
            "type": "string",
            "nullable": true
          },
          "error_code": {
            "type": "string",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
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
            "$ref": "#/components/schemas/PublicCommunityIdentity"
          },
          "stats": {
            "$ref": "#/components/schemas/PublicCommunityStats"
          },
          "omitted_surfaces": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/OmittedStructuredSurface"
            }
          },
          "links": {
            "$ref": "#/components/schemas/StructuredAccessLinks"
          }
        }
      },
      "StructuredPublicPostListResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items",
          "next_cursor",
          "omitted_surfaces",
          "links"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/StructuredPostCard"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          },
          "omitted_surfaces": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/OmittedStructuredSurface"
            }
          },
          "links": {
            "$ref": "#/components/schemas/StructuredAccessLinks"
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
            "$ref": "#/components/schemas/StructuredPostCard"
          },
          "omitted_surfaces": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/OmittedStructuredSurface"
            }
          },
          "links": {
            "$ref": "#/components/schemas/StructuredAccessLinks"
          }
        }
      },
      "StructuredTopCommentsResponse": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "items",
          "next_cursor",
          "top_comments_limit",
          "links"
        ],
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommentListItem"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
          },
          "top_comments_limit": {
            "type": "integer",
            "minimum": 0
          },
          "links": {
            "$ref": "#/components/schemas/StructuredAccessLinks"
          }
        }
      },
      "WalletAttachmentSummary": {
        "type": "object",
        "required": [
          "wallet_attachment",
          "chain_namespace",
          "wallet_address",
          "is_primary"
        ],
        "properties": {
          "wallet_attachment": {
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
      "RequestedVerificationCapability": {
        "type": "string",
        "enum": [
          "unique_human",
          "age_over_18",
          "minimum_age",
          "nationality",
          "gender"
        ]
      },
      "VerificationRequirement": {
        "oneOf": [
          {
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
                "maximum": 125
              }
            }
          },
          {
            "type": "object",
            "required": [
              "proof_type"
            ],
            "properties": {
              "proof_type": {
                "type": "string",
                "enum": [
                  "nationality"
                ]
              },
              "required_values": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          }
        ]
      },
      "VerificationIntent": {
        "type": "string",
        "enum": [
          "profile_verification",
          "community_creation",
          "community_join",
          "post_create",
          "comment_create",
          "post_access_18_plus",
          "commerce_pricing",
          "qualifier_disclosure"
        ]
      },
      "VerificationSessionLaunch": {
        "type": "object",
        "required": [
          "mode"
        ],
        "properties": {
          "mode": {
            "type": "string",
            "enum": [
              "qr_deeplink",
              "widget",
              "native_sdk",
              "web_sdk",
              "none"
            ]
          },
          "self_app": {
            "$ref": "#/components/schemas/SelfVerificationLaunch"
          },
          "very_widget": {
            "$ref": "#/components/schemas/VeryWidgetLaunch"
          },
          "zkpassport": {
            "$ref": "#/components/schemas/ZkPassportVerificationLaunch"
          }
        }
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
      "AgentOwnershipProvider": {
        "type": "string",
        "enum": [
          "self_agent_id",
          "clawkey"
        ]
      },
      "AgentChallenge": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "device",
          "public_key",
          "message",
          "signature",
          "timestamp"
        ],
        "properties": {
          "device": {
            "type": "string"
          },
          "public_key": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "signature": {
            "type": "string"
          },
          "timestamp": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "AgentOwnershipSessionStatus": {
        "type": "string",
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
            "$ref": "#/components/schemas/SelfAgentOwnershipLaunch"
          },
          "clawkey_registration": {
            "$ref": "#/components/schemas/ClawkeyRegistrationLaunch"
          }
        }
      },
      "UserAgentStatus": {
        "type": "string",
        "enum": [
          "pending",
          "active",
          "suspended",
          "revoked",
          "transferred",
          "deregistered"
        ]
      },
      "AgentOwnershipRecord": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "object",
          "agent",
          "owner_user",
          "ownership_provider",
          "ownership_state",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "agent_ownership_record"
            ]
          },
          "agent": {
            "type": "string"
          },
          "owner_user": {
            "type": "string"
          },
          "ownership_provider": {
            "$ref": "#/components/schemas/AgentOwnershipProvider"
          },
          "provider_subject": {
            "type": "string",
            "nullable": true
          },
          "device": {
            "type": "string",
            "nullable": true
          },
          "public_key": {
            "type": "string",
            "nullable": true
          },
          "ownership_state": {
            "$ref": "#/components/schemas/AgentOwnershipState"
          },
          "source_session": {
            "type": "string",
            "nullable": true
          },
          "verified_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "expires_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "ended_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "evidence_ref": {
            "type": "string",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "AgentHandleStatus": {
        "type": "string",
        "enum": [
          "active",
          "redirect",
          "retired"
        ]
      },
      "LinkedHandle": {
        "type": "object",
        "required": [
          "linked_handle",
          "label",
          "kind",
          "verification_state"
        ],
        "properties": {
          "linked_handle": {
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
      "NamespaceVerificationAssertions": {
        "type": "object",
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
            "$ref": "#/components/schemas/VerificationCapabilityState"
          },
          "age_over_18": {
            "allOf": [
              {
                "$ref": "#/components/schemas/VerifiedCapabilityState"
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
                "$ref": "#/components/schemas/VerifiedCapabilityState"
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
                "nullable": true
              }
            }
          },
          "nationality": {
            "allOf": [
              {
                "$ref": "#/components/schemas/VerifiedCapabilityState"
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
                "nullable": true
              }
            }
          },
          "gender": {
            "allOf": [
              {
                "$ref": "#/components/schemas/VerifiedCapabilityState"
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
                "nullable": true
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
            "$ref": "#/components/schemas/WalletScoreCapabilityState"
          }
        }
      },
      "WalletIdentity": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "object",
          "chain_ref",
          "wallet_address",
          "display_label",
          "public_names"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "wallet_identity"
            ]
          },
          "chain_ref": {
            "type": "string"
          },
          "wallet_address": {
            "type": "string"
          },
          "display_label": {
            "type": "string",
            "nullable": true
          },
          "public_names": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/WalletIdentityPublicName"
            }
          }
        }
      },
      "WalletIdentityRedirect": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "object",
          "chain_ref",
          "wallet_address",
          "profile",
          "profile_handle"
        ],
        "properties": {
          "object": {
            "type": "string",
            "enum": [
              "wallet_identity_redirect"
            ]
          },
          "chain_ref": {
            "type": "string"
          },
          "wallet_address": {
            "type": "string"
          },
          "profile": {
            "type": "string"
          },
          "profile_handle": {
            "type": "string"
          }
        }
      },
      "CreateCentralizedCommunityRequest": {
        "allOf": [
          {
            "$ref": "#/components/schemas/CreateCommunityRequestBase"
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
        ]
      },
      "CreateMultisigCommunityRequest": {
        "allOf": [
          {
            "$ref": "#/components/schemas/CreateCommunityRequestBase"
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
                "$ref": "#/components/schemas/MultisigGovernanceAttachmentInput"
              }
            }
          }
        ]
      },
      "CreateMajeurCommunityRequest": {
        "allOf": [
          {
            "$ref": "#/components/schemas/CreateCommunityRequestBase"
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
                "$ref": "#/components/schemas/MajeurGovernanceCreateInput"
              }
            }
          }
        ]
      },
      "HumanVerificationLane": {
        "type": "string",
        "enum": [
          "very",
          "self"
        ]
      },
      "CommunityAgentResolutionOrigin": {
        "type": "string",
        "enum": [
          "derived",
          "explicit"
        ]
      },
      "RootPostQuotaByTrustTier": {
        "type": "object",
        "properties": {
          "new": {
            "$ref": "#/components/schemas/RootPostQuotaRule"
          },
          "established": {
            "$ref": "#/components/schemas/RootPostQuotaRule"
          },
          "trusted": {
            "$ref": "#/components/schemas/RootPostQuotaRule"
          },
          "high_trust": {
            "$ref": "#/components/schemas/RootPostQuotaRule"
          }
        }
      },
      "ReplyQuotaByTrustTier": {
        "type": "object",
        "properties": {
          "new": {
            "$ref": "#/components/schemas/ReplyQuotaRule"
          },
          "established": {
            "$ref": "#/components/schemas/ReplyQuotaRule"
          },
          "trusted": {
            "$ref": "#/components/schemas/ReplyQuotaRule"
          },
          "high_trust": {
            "$ref": "#/components/schemas/ReplyQuotaRule"
          }
        }
      },
      "GatePolicy": {
        "type": "object",
        "required": [
          "version",
          "expression"
        ],
        "properties": {
          "version": {
            "type": "integer",
            "enum": [
              1
            ]
          },
          "expression": {
            "$ref": "#/components/schemas/GateExpression"
          }
        }
      },
      "DonationPartnerSummary": {
        "type": "object",
        "required": [
          "donation_partner",
          "display_name",
          "provider",
          "review_status",
          "status"
        ],
        "properties": {
          "donation_partner": {
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
          "payout_destination_ref": {
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
      "CommunityContentAuthenticityPolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "authenticity_stance",
          "text_policy",
          "image_policy",
          "video_policy",
          "song_policy"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "authenticity_stance": {
            "$ref": "#/components/schemas/CommunityContentAuthenticityStance"
          },
          "text_policy": {
            "$ref": "#/components/schemas/CommunityTextAuthenticityPolicySettings"
          },
          "image_policy": {
            "$ref": "#/components/schemas/CommunityImageAuthenticityPolicySettings"
          },
          "video_policy": {
            "$ref": "#/components/schemas/CommunityVideoAuthenticityPolicySettings"
          },
          "song_policy": {
            "$ref": "#/components/schemas/CommunitySongAuthenticityPolicySettings"
          }
        }
      },
      "CommunityContentAuthenticityDetectionPolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "selection_mode",
          "resolved_profile"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "selection_mode": {
            "$ref": "#/components/schemas/CommunityContentAuthenticityDetectionSelectionMode"
          },
          "resolved_profile": {
            "$ref": "#/components/schemas/CommunityAuthenticityDetectionProfileSummary"
          }
        }
      },
      "CommunityMarketContextPolicy": {
        "type": "object",
        "required": [
          "id",
          "object",
          "policy_origin",
          "mode",
          "enabled_post_types",
          "max_markets_per_post",
          "provider_set",
          "resolved_profile"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_market_context_policy"
            ]
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "mode": {
            "$ref": "#/components/schemas/CommunityMarketContextMode"
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
            "$ref": "#/components/schemas/CommunityMarketContextProviderSet"
          },
          "resolved_profile": {
            "$ref": "#/components/schemas/MarketContextProfileSummary"
          }
        }
      },
      "CommunitySourcePolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "identified_person_media_scope",
          "require_source_url_for_reposts",
          "allow_human_made_fan_art_of_real_people",
          "require_fan_art_disclosure"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "identified_person_media_scope": {
            "$ref": "#/components/schemas/CommunityIdentifiedPersonMediaScope"
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
      "CommunityCaptureEditPolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "basic_adjustments",
          "retouching",
          "compositing",
          "documentary_editing",
          "require_edit_disclosure"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "basic_adjustments": {
            "$ref": "#/components/schemas/CommunityDisclosureDecisionLevel"
          },
          "retouching": {
            "$ref": "#/components/schemas/CommunityDisclosureDecisionLevel"
          },
          "compositing": {
            "$ref": "#/components/schemas/CommunityDisclosureDecisionLevel"
          },
          "documentary_editing": {
            "$ref": "#/components/schemas/CommunityDisclosureDecisionLevel"
          },
          "require_edit_disclosure": {
            "type": "boolean"
          }
        }
      },
      "CommunityAdultContentPolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "suggestive",
          "artistic_nudity",
          "explicit_nudity",
          "explicit_sexual_content",
          "fetish_content"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "suggestive": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "artistic_nudity": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "explicit_nudity": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "explicit_sexual_content": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "fetish_content": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          }
        }
      },
      "CommunityGraphicContentPolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "injury_medical",
          "gore",
          "extreme_gore",
          "body_horror_disturbing",
          "animal_harm"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "injury_medical": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "gore": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "extreme_gore": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "body_horror_disturbing": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "animal_harm": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          }
        }
      },
      "CommunityMotionMediaPolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "allow_animated_images",
          "allow_silent_looping_video",
          "allow_audio_video",
          "require_video_transcription"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
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
          }
        }
      },
      "CommunityLanguagePolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "profanity",
          "slurs"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "profanity": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "slurs": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          }
        }
      },
      "CommunityCivilityPolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "group_directed_demeaning_language",
          "targeted_insults",
          "targeted_harassment",
          "threatening_language"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "group_directed_demeaning_language": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "targeted_insults": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "targeted_harassment": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "threatening_language": {
            "$ref": "#/components/schemas/CommunityEscalationDecisionLevel"
          }
        }
      },
      "CommunityVisualPolicySettings": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community",
          "policy_origin",
          "topless",
          "visible_nipples",
          "visible_buttocks",
          "visible_genitals",
          "bottomless_obscured",
          "implied_sexual_activity",
          "explicit_sexual_activity",
          "sexualized_contact",
          "masturbation",
          "oral_sex",
          "sex_toy_packaging",
          "sex_toy_visible",
          "sex_toy_in_use",
          "anime_manga",
          "furry_anthro",
          "fictional_nudity",
          "fictional_explicit_sex",
          "ambiguous_fictional_age_with_adult_content",
          "possible_minor_with_adult_content",
          "ai_generated_images",
          "ai_generated_adult_images",
          "deepfake_or_face_swap_risk",
          "celebrity_adult_likeness",
          "voyeuristic_or_hidden_camera",
          "watermark",
          "adult_platform_watermark",
          "product_promotion",
          "affiliate_or_sales_link",
          "qr_code",
          "payment_handle",
          "urls_in_image",
          "weapons",
          "gore_or_injury",
          "drugs",
          "hate_symbols",
          "personal_documents",
          "uncertain_age_with_adult_content",
          "low_quality_adult_image",
          "model_uncertain"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "topless": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "visible_nipples": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "visible_buttocks": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "visible_genitals": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "bottomless_obscured": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "implied_sexual_activity": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "explicit_sexual_activity": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "sexualized_contact": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "masturbation": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "oral_sex": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "sex_toy_packaging": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "sex_toy_visible": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "sex_toy_in_use": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "anime_manga": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "furry_anthro": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "fictional_nudity": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "fictional_explicit_sex": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "ambiguous_fictional_age_with_adult_content": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          },
          "possible_minor_with_adult_content": {
            "type": "string",
            "enum": [
              "reject"
            ]
          },
          "ai_generated_images": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "ai_generated_adult_images": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "deepfake_or_face_swap_risk": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          },
          "celebrity_adult_likeness": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          },
          "voyeuristic_or_hidden_camera": {
            "type": "string",
            "enum": [
              "reject"
            ]
          },
          "watermark": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "adult_platform_watermark": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "product_promotion": {
            "$ref": "#/components/schemas/CommunityVisualPolicyDisclosureAction"
          },
          "affiliate_or_sales_link": {
            "$ref": "#/components/schemas/CommunityVisualPolicyDisclosureAction"
          },
          "qr_code": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          },
          "payment_handle": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          },
          "urls_in_image": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "weapons": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "gore_or_injury": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "drugs": {
            "$ref": "#/components/schemas/CommunityVisualPolicyAction"
          },
          "hate_symbols": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          },
          "personal_documents": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          },
          "uncertain_age_with_adult_content": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          },
          "low_quality_adult_image": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          },
          "model_uncertain": {
            "type": "string",
            "enum": [
              "queue",
              "reject"
            ]
          }
        }
      },
      "CommunityProvenancePolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "allowed_creator_relations",
          "require_creator_relation",
          "false_claim_consequence",
          "allow_oc_claim",
          "require_proof_for_original"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "allowed_creator_relations": {
            "type": "array",
            "minItems": 1,
            "items": {
              "$ref": "#/components/schemas/CommunityCreatorRelation"
            }
          },
          "require_creator_relation": {
            "type": "boolean"
          },
          "false_claim_consequence": {
            "$ref": "#/components/schemas/CommunityFalseClaimConsequence"
          },
          "allow_oc_claim": {
            "type": "boolean"
          },
          "require_proof_for_original": {
            "type": "boolean"
          }
        }
      },
      "CommunityPromotionPolicy": {
        "type": "object",
        "required": [
          "community",
          "policy_origin",
          "self_promotion_mode",
          "require_affiliation_disclosure"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "policy_origin": {
            "$ref": "#/components/schemas/CommunityPolicyOrigin"
          },
          "self_promotion_mode": {
            "$ref": "#/components/schemas/CommunitySelfPromotionMode"
          },
          "require_affiliation_disclosure": {
            "type": "boolean"
          },
          "max_promotional_posts_per_week": {
            "type": "integer",
            "nullable": true
          },
          "promotional_participation_ratio_decimal": {
            "type": "string",
            "pattern": "^\\d+(\\.\\d+)?$",
            "nullable": true
          },
          "require_minimum_membership_days": {
            "type": "integer",
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
              "$ref": "#/components/schemas/CommunityLabelDefinition"
            }
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
              "$ref": "#/components/schemas/CommunityRule"
            }
          },
          "resource_links": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityResourceLink"
            }
          }
        }
      },
      "CommunityReferenceLinkPublic": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community_reference_link",
          "platform",
          "url",
          "link_status",
          "verified",
          "metadata",
          "position"
        ],
        "properties": {
          "community_reference_link": {
            "type": "string"
          },
          "platform": {
            "$ref": "#/components/schemas/CommunityReferenceLinkPlatform"
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "external": {
            "type": "string",
            "nullable": true
          },
          "label": {
            "type": "string",
            "nullable": true
          },
          "link_status": {
            "$ref": "#/components/schemas/CommunityReferenceLinkStatus"
          },
          "verified": {
            "type": "boolean"
          },
          "verified_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "metadata": {
            "$ref": "#/components/schemas/CommunityReferenceLinkMetadata"
          },
          "position": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "CommunityGovernanceBackend": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/CentralizedGovernanceBackend"
          },
          {
            "$ref": "#/components/schemas/MultisigGovernanceBackend"
          },
          {
            "$ref": "#/components/schemas/MajeurGovernanceBackend"
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
      "GateRule": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "scope",
          "gate_family",
          "gate_type",
          "status",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "gate_rule"
            ]
          },
          "community": {
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
              "$ref": "#/components/schemas/ProofRequirement"
            }
          },
          "chain_namespace": {
            "type": "string",
            "nullable": true
          },
          "gate_config": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "disabled"
            ]
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "CommunityPolicyOrigin": {
        "type": "string",
        "enum": [
          "default",
          "explicit"
        ]
      },
      "CommunityMoneyAssetRef": {
        "type": "object",
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
      "CommunityFundingRouteStatusPolicy": {
        "type": "string",
        "enum": [
          "fail",
          "fallback_display",
          "queue"
        ]
      },
      "CommunityPricingVerificationProvider": {
        "type": "string",
        "enum": [
          "self"
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
            "$ref": "#/components/schemas/CommunityPricingAdjustmentType"
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
            "maxLength": 2
          },
          "tier_key": {
            "type": "string"
          }
        }
      },
      "CommunityPurchaseSettlementMode": {
        "type": "string",
        "enum": [
          "delivery_only_story_settlement",
          "royalty_native_story_payment"
        ]
      },
      "CommunitySaleAllocationLeg": {
        "allOf": [
          {
            "$ref": "#/components/schemas/CommunitySaleAllocationSnapshot"
          },
          {
            "type": "object",
            "required": [
              "status"
            ],
            "additionalProperties": false,
            "properties": {
              "status": {
                "$ref": "#/components/schemas/CommunitySaleAllocationStatus"
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
      "CommunityPurchaseFundingMode": {
        "type": "string",
        "enum": [
          "direct",
          "routed"
        ]
      },
      "CommunitySaleAllocationSnapshot": {
        "type": "object",
        "required": [
          "recipient_type",
          "waterfall_position",
          "share_bps",
          "amount_cents",
          "settlement_strategy"
        ],
        "additionalProperties": false,
        "properties": {
          "recipient_type": {
            "$ref": "#/components/schemas/CommunitySaleAllocationRecipientType"
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
          "amount_cents": {
            "type": "integer",
            "minimum": 0
          },
          "settlement_strategy": {
            "$ref": "#/components/schemas/CommunitySaleAllocationSettlementStrategy"
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
              "$ref": "#/components/schemas/CommunityTextLocalizationItem"
            }
          }
        }
      },
      "CommunityRoleSummary": {
        "type": "object",
        "required": [
          "user",
          "display_name",
          "handle",
          "role"
        ],
        "properties": {
          "user": {
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
              "altcha_pow",
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
                "zkpassport",
                "very",
                "passport"
              ]
            }
          },
          "required_value": {
            "type": "string",
            "nullable": true
          },
          "required_values": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
          },
          "excluded_values": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
          },
          "required_minimum_age": {
            "type": "integer",
            "nullable": true,
            "minimum": 18,
            "maximum": 125
          },
          "minimum_score": {
            "type": "number",
            "nullable": true,
            "minimum": 0,
            "maximum": 100
          },
          "chain_namespace": {
            "type": "string",
            "nullable": true
          },
          "contract_address": {
            "type": "string",
            "nullable": true
          },
          "inventory_provider": {
            "type": "string",
            "nullable": true,
            "enum": [
              "courtyard"
            ]
          },
          "min_quantity": {
            "type": "integer",
            "nullable": true,
            "minimum": 1,
            "maximum": 100
          },
          "asset_filter_label": {
            "type": "string",
            "nullable": true
          },
          "asset_category": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CommunityRule": {
        "type": "object",
        "required": [
          "id",
          "object",
          "title",
          "body",
          "report_reason",
          "position",
          "status"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_rule"
            ]
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
      "GatePolicyEvaluation": {
        "type": "object",
        "required": [
          "passed",
          "trace",
          "required_action_set"
        ],
        "properties": {
          "passed": {
            "type": "boolean"
          },
          "trace": {
            "$ref": "#/components/schemas/GateTraceNode"
          },
          "required_action_set": {
            "$ref": "#/components/schemas/RequiredActionSet",
            "nullable": true
          }
        }
      },
      "LiveRoomReplayAsset": {
        "type": "object",
        "required": [
          "id",
          "object",
          "publication_status",
          "title",
          "caption",
          "duration_ms",
          "preview_ref",
          "access_mode",
          "locked_delivery_status",
          "published_at",
          "allocations"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "object": {
            "type": "string",
            "enum": [
              "live_room_replay_asset"
            ]
          },
          "publication_status": {
            "type": "string",
            "enum": [
              "draft",
              "published",
              "failed"
            ]
          },
          "title": {
            "type": "string"
          },
          "caption": {
            "type": "string",
            "nullable": true
          },
          "duration_ms": {
            "type": "integer",
            "nullable": true
          },
          "preview_ref": {
            "type": "string",
            "nullable": true
          },
          "access_mode": {
            "type": "string",
            "enum": [
              "free",
              "included_with_ticket",
              "paid"
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
          "published_at": {
            "type": "string",
            "nullable": true
          },
          "allocations": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/LiveRoomReplayAllocation"
            }
          }
        }
      },
      "LiveRoomRecording": {
        "type": "object",
        "required": [
          "id",
          "provider",
          "status",
          "failure_reason",
          "raw_artifact"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "provider": {
            "type": "string",
            "enum": [
              "agora"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "starting",
              "recording",
              "stopping",
              "captured",
              "ingesting",
              "failed"
            ]
          },
          "failure_reason": {
            "type": "string",
            "nullable": true
          },
          "raw_artifact": {
            "nullable": true,
            "$ref": "#/components/schemas/LiveRoomRecordingRawArtifact"
          }
        }
      },
      "UpdateLiveRoomReplayAllocation": {
        "type": "object",
        "properties": {
          "participant_user": {
            "type": "string",
            "nullable": true
          },
          "external_party_ref": {
            "type": "string",
            "nullable": true
          },
          "role": {
            "type": "string",
            "nullable": true
          },
          "share_bps": {
            "type": "integer",
            "nullable": true,
            "minimum": 0,
            "maximum": 10000
          }
        }
      },
      "ImageMediaDescriptor": {
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
      "RoyaltyAllocationRequest": {
        "type": "object",
        "required": [
          "recipient_kind",
          "wallet_address",
          "share_bps"
        ],
        "properties": {
          "recipient_kind": {
            "type": "string",
            "enum": [
              "creator",
              "collaborator"
            ]
          },
          "wallet_address": {
            "type": "string"
          },
          "share_bps": {
            "type": "integer",
            "minimum": 1,
            "maximum": 10000
          }
        }
      },
      "VideoMediaDescriptor": {
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
          },
          "preview_video": {
            "$ref": "#/components/schemas/SongVideoArtifactDescriptor",
            "nullable": true
          }
        }
      },
      "AudioMediaDescriptor": {
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
      "CreatePostListingDraft": {
        "type": "object",
        "required": [
          "price_cents",
          "regional_pricing_enabled",
          "status"
        ],
        "additionalProperties": false,
        "properties": {
          "price_cents": {
            "type": "integer",
            "minimum": 0
          },
          "regional_pricing_enabled": {
            "type": "boolean"
          },
          "donation_partner": {
            "type": "string",
            "nullable": true
          },
          "donation_share_bps": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "vinyl_release_provider": {
            "type": "string",
            "enum": [
              "elasticstage"
            ],
            "nullable": true
          },
          "vinyl_release_url": {
            "type": "string",
            "format": "uri",
            "nullable": true
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
        "properties": {
          "nonce": {
            "type": "string"
          },
          "signed_at": {
            "type": "integer",
            "format": "int64"
          },
          "canonical_request_hash": {
            "type": "string"
          },
          "signature": {
            "type": "string"
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
          "decentralized_storage": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
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
          },
          "preview_video": {
            "$ref": "#/components/schemas/SongVideoArtifactDescriptor",
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
            "$ref": "#/components/schemas/PromotionAffiliationKind"
          }
        }
      },
      "DisclosedQualifierSnapshot": {
        "type": "object",
        "required": [
          "qualifier_template",
          "rendered_label",
          "qualifier_kind",
          "qualifier_source"
        ],
        "properties": {
          "qualifier_template": {
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
      "PostPublishFailureCode": {
        "type": "string",
        "enum": [
          "song_analysis_blocked",
          "song_analysis_review_required",
          "song_rights_reference_required",
          "song_preview_generation_failed",
          "text_moderation_blocked",
          "story_royalty_registration_failed",
          "story_locked_delivery_failed",
          "listing_creation_failed",
          "catalog_sync_failed",
          "provider_unavailable",
          "internal_error"
        ]
      },
      "PostEmbed": {
        "oneOf": [
          {
            "$ref": "#/components/schemas/XPostEmbed"
          },
          {
            "$ref": "#/components/schemas/YouTubeVideoEmbed"
          },
          {
            "$ref": "#/components/schemas/KalshiMarketEmbed"
          },
          {
            "$ref": "#/components/schemas/PolymarketMarketEmbed"
          }
        ]
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
            "$ref": "#/components/schemas/PromotionAffiliationKind"
          }
        }
      },
      "CrosspostSource": {
        "type": "object",
        "required": [
          "status",
          "post",
          "community"
        ],
        "properties": {
          "status": {
            "$ref": "#/components/schemas/CrosspostSourceStatus"
          },
          "post": {
            "type": "string"
          },
          "community": {
            "type": "string"
          },
          "captured_at": {
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
            ],
            "nullable": true
          },
          "title": {
            "type": "string",
            "nullable": true
          },
          "community_label": {
            "type": "string",
            "nullable": true
          },
          "community_route_slug": {
            "type": "string",
            "nullable": true
          },
          "author_user": {
            "type": "string",
            "nullable": true
          },
          "author_label": {
            "type": "string",
            "nullable": true
          },
          "thumbnail_ref": {
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
            "$ref": "#/components/schemas/HomeFeedCommunitySummary"
          },
          "post": {
            "$ref": "#/components/schemas/LocalizedPostResponse"
          }
        }
      },
      "HomeFeedCommunitySummary": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "object",
          "display_name"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "home_feed_community_summary"
            ]
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
          "view_count": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "CommentListItem": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "object",
          "comment",
          "viewer_vote",
          "resolved_locale",
          "translation_state",
          "machine_translated",
          "source_hash"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "comment_list_item"
            ]
          },
          "comment": {
            "$ref": "#/components/schemas/Comment"
          },
          "viewer_vote": {
            "type": "integer",
            "enum": [
              -1,
              1
            ],
            "nullable": true
          },
          "viewer_can_delete": {
            "type": "boolean"
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
      "CommentThreadSnapshot": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "thread_root_post",
          "snapshot_seq",
          "published_through_comment_created",
          "comment_count",
          "swarm_manifest_ref",
          "swarm_feed_ref",
          "created"
        ],
        "properties": {
          "thread_root_post": {
            "type": "string"
          },
          "snapshot_seq": {
            "type": "integer"
          },
          "published_through_comment_created": {
            "type": "integer",
            "format": "int64"
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
          "created": {
            "type": "integer",
            "format": "int64"
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
      "KaraokeScoringPolicy": {
        "oneOf": [
          {
            "type": "object",
            "required": [
              "kind"
            ],
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "disabled"
                ]
              }
            }
          },
          {
            "type": "object",
            "required": [
              "kind",
              "provider",
              "model",
              "retention"
            ],
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "enabled"
                ]
              },
              "provider": {
                "type": "string",
                "enum": [
                  "assistant",
                  "elevenlabs",
                  "mistral",
                  "openai"
                ]
              },
              "model": {
                "type": "string"
              },
              "retention": {
                "type": "string",
                "enum": [
                  "not_stored"
                ]
              },
              "voice_coach_enabled": {
                "type": "boolean"
              }
            }
          }
        ]
      },
      "SongStudyAccessState": {
        "type": "string",
        "enum": [
          "ready",
          "locked",
          "processing",
          "unavailable"
        ]
      },
      "SongStudyExercise": {
        "oneOf": [
          {
            "type": "object",
            "title": "SongStudySayItBackExercise",
            "required": [
              "id",
              "type",
              "line_id",
              "line_index",
              "prompt_text",
              "reference_text",
              "max_attempts"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "type": {
                "type": "string",
                "enum": [
                  "say_it_back"
                ]
              },
              "line_id": {
                "type": "string"
              },
              "line_index": {
                "type": "integer"
              },
              "prompt_text": {
                "type": "string"
              },
              "reference_text": {
                "type": "string"
              },
              "translation_text": {
                "type": "string",
                "nullable": true
              },
              "max_attempts": {
                "type": "integer"
              }
            },
            "additionalProperties": false
          },
          {
            "type": "object",
            "title": "SongStudyTranslationChoiceExercise",
            "required": [
              "id",
              "type",
              "line_id",
              "line_index",
              "prompt_text",
              "question",
              "options",
              "max_attempts"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "type": {
                "type": "string",
                "enum": [
                  "translation_choice"
                ]
              },
              "line_id": {
                "type": "string"
              },
              "line_index": {
                "type": "integer"
              },
              "prompt_text": {
                "type": "string"
              },
              "question": {
                "type": "string"
              },
              "options": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "text"
                  ],
                  "properties": {
                    "id": {
                      "type": "string"
                    },
                    "text": {
                      "type": "string"
                    }
                  },
                  "additionalProperties": false
                }
              },
              "max_attempts": {
                "type": "integer"
              }
            },
            "additionalProperties": false
          }
        ]
      },
      "SongStudySessionSummary": {
        "type": "object",
        "required": [
          "due_count",
          "served_count",
          "total_units"
        ],
        "properties": {
          "due_count": {
            "type": "integer"
          },
          "served_count": {
            "type": "integer"
          },
          "total_units": {
            "type": "integer"
          },
          "next_due_at": {
            "type": "integer",
            "format": "int64"
          }
        },
        "additionalProperties": false
      },
      "SongStudyLockedReason": {
        "type": "string",
        "enum": [
          "purchase_required",
          "membership_required",
          "age_required"
        ]
      },
      "SongStudyUnavailableReason": {
        "type": "string",
        "enum": [
          "not_song",
          "no_lyrics",
          "unsupported_language",
          "generation_failed",
          "missing_transcription_provider"
        ]
      },
      "SongStreakLeaderboardEntry": {
        "type": "object",
        "required": [
          "rank",
          "identity",
          "current_streak",
          "best_streak",
          "total_qualified_days",
          "streak_started_date",
          "last_qualified_date",
          "is_viewer"
        ],
        "properties": {
          "rank": {
            "type": "integer"
          },
          "identity": {
            "$ref": "#/components/schemas/SongStreakLeaderboardIdentity"
          },
          "current_streak": {
            "type": "integer"
          },
          "best_streak": {
            "type": "integer"
          },
          "total_qualified_days": {
            "type": "integer"
          },
          "streak_started_date": {
            "type": "string"
          },
          "last_qualified_date": {
            "type": "string"
          },
          "is_viewer": {
            "type": "boolean"
          }
        },
        "additionalProperties": false
      },
      "SongStreakViewerStanding": {
        "type": "object",
        "required": [
          "alive",
          "current_streak",
          "best_streak",
          "total_qualified_days",
          "qualified_today",
          "study_attempts_today",
          "study_target_today",
          "karaoke_passed_today"
        ],
        "properties": {
          "alive": {
            "type": "boolean"
          },
          "current_streak": {
            "type": "integer"
          },
          "best_streak": {
            "type": "integer"
          },
          "total_qualified_days": {
            "type": "integer"
          },
          "qualified_today": {
            "type": "boolean"
          },
          "study_attempts_today": {
            "type": "integer"
          },
          "study_target_today": {
            "type": "integer"
          },
          "karaoke_passed_today": {
            "type": "boolean"
          }
        },
        "additionalProperties": false
      },
      "ModerationCaseListItem": {
        "allOf": [
          {
            "$ref": "#/components/schemas/ModerationCase"
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "post"
            ],
            "properties": {
              "post": {
                "$ref": "#/components/schemas/ModerationCasePostPreview",
                "nullable": true
              }
            }
          }
        ]
      },
      "ModerationCase": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "post",
          "comment",
          "status",
          "queue_scope",
          "priority",
          "opened_by",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "moderation_case"
            ]
          },
          "community": {
            "type": "string"
          },
          "post": {
            "type": "string",
            "nullable": true
          },
          "comment": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "$ref": "#/components/schemas/ModerationCaseStatus"
          },
          "queue_scope": {
            "$ref": "#/components/schemas/ModerationQueueScope"
          },
          "priority": {
            "$ref": "#/components/schemas/ModerationSignalSeverity"
          },
          "opened_by": {
            "$ref": "#/components/schemas/ModerationCaseOpenedBy"
          },
          "created": {
            "type": "integer",
            "format": "int64"
          },
          "resolved_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
      },
      "ModerationSignal": {
        "type": "object",
        "required": [
          "id",
          "object",
          "community",
          "post",
          "comment",
          "analysis_result_ref",
          "source",
          "signal_type",
          "severity",
          "provider",
          "provider_label",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "moderation_signal"
            ]
          },
          "community": {
            "type": "string"
          },
          "post": {
            "type": "string",
            "nullable": true
          },
          "comment": {
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
            "$ref": "#/components/schemas/ModerationSignalSeverity"
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
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "ModerationAction": {
        "type": "object",
        "required": [
          "id",
          "object",
          "moderation_case",
          "community",
          "post",
          "comment",
          "actor_user",
          "action_type",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "moderation_action"
            ]
          },
          "moderation_case": {
            "type": "string"
          },
          "community": {
            "type": "string"
          },
          "post": {
            "type": "string",
            "nullable": true
          },
          "comment": {
            "type": "string",
            "nullable": true
          },
          "actor_user": {
            "type": "string"
          },
          "action_type": {
            "$ref": "#/components/schemas/ModerationActionType"
          },
          "note": {
            "type": "string",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
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
      "RightsReviewCaseListItem": {
        "allOf": [
          {
            "$ref": "#/components/schemas/RightsReviewCase"
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "analysis",
              "post"
            ],
            "properties": {
              "analysis": {
                "$ref": "#/components/schemas/MediaAnalysisResult",
                "nullable": true
              },
              "post": {
                "$ref": "#/components/schemas/ModerationCasePostPreview",
                "nullable": true
              }
            }
          }
        ]
      },
      "RightsReviewCase": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "rights_review_case_id",
          "subject_type",
          "subject_id",
          "community_id",
          "status",
          "trigger_source",
          "analysis_result_ref",
          "submitted_evidence_refs",
          "resolution",
          "resolver_user_id",
          "created_at",
          "updated_at",
          "resolved_at"
        ],
        "properties": {
          "rights_review_case_id": {
            "type": "string"
          },
          "subject_type": {
            "type": "string",
            "enum": [
              "asset",
              "post",
              "live_room",
              "replay_asset"
            ]
          },
          "subject_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "open",
              "under_review",
              "resolved",
              "blocked"
            ]
          },
          "trigger_source": {
            "type": "string",
            "enum": [
              "acrcloud_match",
              "declared_reference_mismatch",
              "manual_report",
              "operator_escalation"
            ]
          },
          "analysis_result_ref": {
            "type": "string",
            "nullable": true
          },
          "submitted_evidence_refs": {
            "nullable": true
          },
          "resolution": {
            "type": "string",
            "enum": [
              "clear",
              "clear_with_upstream_refs",
              "block",
              "needs_more_evidence"
            ],
            "nullable": true
          },
          "resolver_user_id": {
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
          },
          "resolved_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          }
        }
      },
      "MediaAnalysisResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "media_analysis_result_id",
          "community_id",
          "source_post_id",
          "source_asset_id",
          "outcome",
          "content_safety_state",
          "age_gate_policy",
          "trigger_sources",
          "acrcloud_music_match",
          "acrcloud_custom_match",
          "acrcloud_error_code",
          "acrcloud_error_message",
          "acrcloud_checked_at",
          "safety_signals",
          "authenticity_signals",
          "policy_reason_code",
          "policy_reason",
          "resolved_at",
          "created_at",
          "updated_at"
        ],
        "properties": {
          "media_analysis_result_id": {
            "type": "string"
          },
          "community_id": {
            "type": "string"
          },
          "source_post_id": {
            "type": "string",
            "nullable": true
          },
          "source_asset_id": {
            "type": "string",
            "nullable": true
          },
          "outcome": {
            "type": "string",
            "enum": [
              "allow",
              "allow_with_required_reference",
              "review_required",
              "blocked"
            ]
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
          "trigger_sources": {
            "nullable": true
          },
          "acrcloud_music_match": {
            "nullable": true
          },
          "acrcloud_custom_match": {
            "nullable": true
          },
          "acrcloud_error_code": {
            "type": "string",
            "nullable": true
          },
          "acrcloud_error_message": {
            "type": "string",
            "nullable": true
          },
          "acrcloud_checked_at": {
            "type": "string",
            "format": "date-time",
            "nullable": true
          },
          "safety_signals": {
            "nullable": true
          },
          "authenticity_signals": {
            "nullable": true
          },
          "policy_reason_code": {
            "type": "string",
            "nullable": true
          },
          "policy_reason": {
            "type": "string",
            "nullable": true
          },
          "resolved_at": {
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
      "SongArtifactUploadRef": {
        "type": "object",
        "required": [
          "song_artifact_upload"
        ],
        "additionalProperties": false,
        "properties": {
          "song_artifact_upload": {
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
          "decentralized_storage": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
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
          "upload_mode": {
            "type": "string",
            "enum": [
              "proxy",
              "direct_multipart"
            ]
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
      "PostViewerGateState": {
        "type": "object",
        "required": [
          "community_id",
          "community_display_name",
          "viewer_community_role",
          "viewer_membership_status",
          "membership_gate_summaries"
        ],
        "additionalProperties": false,
        "properties": {
          "community_id": {
            "type": "string"
          },
          "community_display_name": {
            "type": "string"
          },
          "viewer_community_role": {
            "type": "string",
            "enum": [
              "owner",
              "admin",
              "moderator"
            ],
            "nullable": true
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
          "membership_gate_summaries": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/MembershipGateSummary"
            }
          },
          "gate_match_mode": {
            "type": "string",
            "enum": [
              "all",
              "any"
            ],
            "nullable": true
          }
        }
      },
      "MarketContextSummary": {
        "type": "object",
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
            "items": {
              "$ref": "#/components/schemas/MarketContextMarket"
            }
          }
        }
      },
      "PostLabel": {
        "type": "object",
        "required": [
          "id",
          "object",
          "label",
          "status"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "post_label"
            ]
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
      "SongPresentation": {
        "type": "object",
        "required": [
          "title",
          "cover_art_ref",
          "duration_ms"
        ],
        "properties": {
          "title": {
            "type": "string",
            "nullable": true
          },
          "cover_art_ref": {
            "type": "string",
            "nullable": true
          },
          "duration_ms": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          }
        }
      },
      "SongStudyCapability": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "status"
        ],
        "properties": {
          "status": {
            "type": "string",
            "enum": [
              "ready",
              "locked",
              "processing",
              "unavailable"
            ]
          },
          "exercise_count": {
            "type": "integer",
            "minimum": 0,
            "nullable": true
          },
          "source_language": {
            "type": "string",
            "nullable": true
          },
          "target_language": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "SongStreakSummary": {
        "type": "object",
        "required": [
          "entries",
          "viewer",
          "total_active_streaks"
        ],
        "properties": {
          "entries": {
            "type": "array",
            "maxItems": 3,
            "items": {
              "$ref": "#/components/schemas/SongStreakLeaderboardEntry"
            }
          },
          "viewer": {
            "nullable": true,
            "oneOf": [
              {
                "$ref": "#/components/schemas/SongStreakViewerStanding"
              }
            ]
          },
          "total_active_streaks": {
            "type": "integer"
          }
        },
        "additionalProperties": false
      },
      "PostAssetStorySummary": {
        "type": "object",
        "required": [
          "story_ip",
          "story_royalty_registration_status"
        ],
        "additionalProperties": false,
        "properties": {
          "story_ip": {
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
          }
        }
      },
      "PostDerivativeSource": {
        "type": "object",
        "required": [
          "source_ref",
          "title",
          "kind",
          "relationship_type"
        ],
        "additionalProperties": false,
        "properties": {
          "source_ref": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "song",
              "video",
              "external"
            ]
          },
          "relationship_type": {
            "type": "string",
            "enum": [
              "remix_of",
              "references_song",
              "references_video",
              "inspired_by",
              "samples"
            ]
          },
          "community": {
            "type": "string",
            "nullable": true
          },
          "asset": {
            "type": "string",
            "nullable": true
          },
          "source_post": {
            "type": "string",
            "nullable": true
          },
          "story_ip": {
            "type": "string",
            "nullable": true
          },
          "story_license_terms": {
            "type": "string",
            "nullable": true
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
          "creator_user": {
            "type": "string",
            "nullable": true
          },
          "creator_handle": {
            "type": "string",
            "nullable": true
          },
          "creator_display_name": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "LocalizedPostEmbedTranslation": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "embed_key",
          "source_hash"
        ],
        "properties": {
          "embed_key": {
            "type": "string"
          },
          "translated_question": {
            "type": "string",
            "nullable": true
          },
          "translated_title": {
            "type": "string",
            "nullable": true
          },
          "translated_outcomes": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "label",
                "translated_label",
                "source_hash"
              ],
              "properties": {
                "label": {
                  "type": "string"
                },
                "translated_label": {
                  "type": "string",
                  "nullable": true
                },
                "source_hash": {
                  "type": "string"
                }
              }
            }
          },
          "source_hash": {
            "type": "string"
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
            "$ref": "#/components/schemas/NotificationEvent"
          },
          "receipt": {
            "$ref": "#/components/schemas/NotificationReceipt"
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
      "PublicCommunityIdentity": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "community",
          "slug",
          "name"
        ],
        "properties": {
          "community": {
            "type": "string"
          },
          "slug": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "join_requirements": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "created": {
            "type": "integer",
            "format": "int64",
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
            "enum": [
              "community_opt_out",
              "platform_disabled",
              "not_visible",
              "not_in_v0"
            ]
          }
        }
      },
      "StructuredAccessLinks": {
        "type": "object",
        "additionalProperties": {
          "$ref": "#/components/schemas/StructuredAccessLink"
        }
      },
      "StructuredPostCard": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "post",
          "community",
          "title",
          "created",
          "reply_count",
          "links"
        ],
        "properties": {
          "post": {
            "type": "string"
          },
          "community": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "author_handle": {
            "type": "string",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
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
            "nullable": true
          },
          "media": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": true
            }
          },
          "links": {
            "$ref": "#/components/schemas/StructuredAccessLinks"
          }
        }
      },
      "SelfVerificationLaunch": {
        "type": "object",
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
            "$ref": "#/components/schemas/SelfVerificationDisclosures"
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
            "additionalProperties": true
          },
          "verify_url": {
            "type": "string"
          },
          "session_binding": {
            "$ref": "#/components/schemas/VerySessionBinding"
          }
        }
      },
      "ZkPassportVerificationLaunch": {
        "type": "object",
        "required": [
          "domain",
          "name",
          "purpose",
          "scope",
          "binding",
          "requested_capabilities",
          "verification_requirements"
        ],
        "properties": {
          "domain": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "logo": {
            "type": "string",
            "nullable": true
          },
          "purpose": {
            "type": "string"
          },
          "scope": {
            "type": "string"
          },
          "binding": {
            "type": "string"
          },
          "validity_seconds": {
            "type": "integer",
            "nullable": true
          },
          "dev_mode": {
            "type": "boolean",
            "nullable": true
          },
          "requested_capabilities": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/RequestedVerificationCapability"
            }
          },
          "verification_requirements": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/VerificationRequirement"
            }
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
          "session",
          "registration_url"
        ],
        "properties": {
          "session": {
            "type": "string"
          },
          "registration_url": {
            "type": "string"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
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
      "VerificationCapabilityState": {
        "type": "object",
        "required": [
          "state"
        ],
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
      },
      "VerifiedCapabilityState": {
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
              "self",
              "zkpassport"
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
      },
      "WalletIdentityPublicName": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "label",
          "label_normalized",
          "status",
          "owner_kind",
          "owner_wallet_address",
          "chain_ref",
          "price_paid_cents",
          "currency",
          "issued_at",
          "expires_at",
          "pirate_user_id"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          },
          "label_normalized": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "active"
            ]
          },
          "owner_kind": {
            "type": "string",
            "enum": [
              "wallet"
            ]
          },
          "owner_wallet_address": {
            "type": "string"
          },
          "chain_ref": {
            "type": "string"
          },
          "price_paid_cents": {
            "type": "integer",
            "minimum": 0
          },
          "currency": {
            "type": "string",
            "enum": [
              "USD"
            ]
          },
          "issued_at": {
            "type": "integer",
            "format": "int64"
          },
          "expires_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "pirate_user_id": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CreateCommunityRequestBase": {
        "type": "object",
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
            ]
          },
          "localized_text": {
            "$ref": "#/components/schemas/CommunityTextLocalization",
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
          "artist_identity": {
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
          "guest_comment_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "altcha_required"
            ],
            "nullable": true
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
            "$ref": "#/components/schemas/RootPostQuotaByTrustTier",
            "nullable": true
          },
          "reply_quota_by_trust_tier": {
            "$ref": "#/components/schemas/ReplyQuotaByTrustTier",
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
            "default": "none"
          },
          "gate_policy": {
            "$ref": "#/components/schemas/GatePolicy",
            "nullable": true
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
            "nullable": true
          },
          "agent_daily_reply_cap": {
            "type": "integer",
            "nullable": true
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
            "type": "string",
            "enum": [
              "very",
              "self"
            ],
            "nullable": true
          },
          "accepted_agent_ownership_providers": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "#/components/schemas/AgentOwnershipProvider"
            }
          },
          "namespace": {
            "allOf": [
              {
                "$ref": "#/components/schemas/NamespaceAttachmentInput"
              }
            ],
            "nullable": true
          },
          "handle_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/HandlePolicyInput"
              }
            ]
          },
          "donation_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityDonationPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "content_authenticity_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityContentAuthenticityPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "source_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunitySourcePolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "capture_edit_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityCaptureEditPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "adult_content_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityAdultContentPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "graphic_content_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityGraphicContentPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "motion_media_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityMotionMediaPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "language_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityLanguagePolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "civility_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityCivilityPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "provenance_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityProvenancePolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "promotion_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityPromotionPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "content_authenticity_detection_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityContentAuthenticityDetectionPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "market_context_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityMarketContextPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "money_policy": {
            "allOf": [
              {
                "$ref": "#/components/schemas/CreateCommunityMoneyPolicyInput"
              }
            ],
            "type": "object",
            "nullable": true
          },
          "community_bootstrap": {
            "$ref": "#/components/schemas/CreateCommunityBootstrapInput",
            "nullable": true
          },
          "gate_rules": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/GateRuleInput"
            },
            "nullable": true
          }
        }
      },
      "MultisigGovernanceAttachmentInput": {
        "type": "object",
        "required": [
          "chain",
          "contract_address",
          "attachment_proof"
        ],
        "properties": {
          "chain": {
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
            "$ref": "#/components/schemas/MultisigAttachmentProofInput"
          }
        }
      },
      "MajeurGovernanceCreateInput": {
        "type": "object",
        "required": [
          "chain",
          "summon"
        ],
        "properties": {
          "chain": {
            "type": "integer"
          },
          "summon": {
            "$ref": "#/components/schemas/MajeurSafeSummonInput"
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
      "GateExpression": {
        "type": "object",
        "required": [
          "op"
        ],
        "additionalProperties": true,
        "properties": {
          "op": {
            "type": "string",
            "enum": [
              "and",
              "or",
              "gate"
            ]
          },
          "children": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": true
            }
          },
          "gate": {
            "$ref": "#/components/schemas/GateAtom"
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
      "CommunityContentAuthenticityDetectionSelectionMode": {
        "type": "string",
        "enum": [
          "platform_default",
          "approved_profile"
        ]
      },
      "CommunityAuthenticityDetectionProfileSummary": {
        "type": "object",
        "required": [
          "authenticity_detection_profile",
          "profile_key",
          "provider_key",
          "supported_capabilities",
          "status"
        ],
        "properties": {
          "authenticity_detection_profile": {
            "type": "string"
          },
          "profile_key": {
            "type": "string"
          },
          "provider_key": {
            "type": "string"
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
            "$ref": "#/components/schemas/CommunityAuthenticityDetectionProfileStatus"
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
      "MarketContextProfileSummary": {
        "type": "object",
        "required": [
          "market_context_profile",
          "profile_key",
          "provider_keys",
          "status"
        ],
        "properties": {
          "market_context_profile": {
            "type": "string"
          },
          "profile_key": {
            "type": "string"
          },
          "provider_keys": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "status": {
            "$ref": "#/components/schemas/MarketContextProfileStatus"
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
      "CommunityDisclosureDecisionLevel": {
        "type": "string",
        "enum": [
          "allow",
          "require_disclosure",
          "disallow"
        ]
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
      "CommunityVisualPolicyAction": {
        "type": "string",
        "enum": [
          "allow",
          "queue",
          "reject"
        ]
      },
      "CommunityVisualPolicyDisclosureAction": {
        "type": "string",
        "enum": [
          "allow",
          "allow_with_disclosure",
          "queue",
          "reject"
        ]
      },
      "CommunityCreatorRelation": {
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
      "CommunityFalseClaimConsequence": {
        "type": "string",
        "enum": [
          "warning",
          "post_removed",
          "temporary_ban",
          "permanent_ban"
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
      "CommunityLabelDefinition": {
        "type": "object",
        "required": [
          "id",
          "object",
          "label",
          "status",
          "position"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_label_definition"
            ]
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
      "CommunityResourceLink": {
        "type": "object",
        "required": [
          "id",
          "object",
          "label",
          "url",
          "resource_kind",
          "position",
          "status"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "community_resource_link"
            ]
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
      "CommunityReferenceLinkMetadata": {
        "type": "object",
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
            "$ref": "#/components/schemas/GovernanceVerificationState"
          },
          "governance_display_label": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "MultisigGovernanceBackend": {
        "type": "object",
        "required": [
          "governance_mode",
          "governance_chain",
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
          "governance_chain": {
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
            "$ref": "#/components/schemas/GovernanceVerificationState"
          },
          "governance_display_label": {
            "type": "string",
            "nullable": true
          },
          "governance_attached_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "governance_last_verified_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "governance_metadata": {
            "$ref": "#/components/schemas/MultisigGovernanceMetadata"
          }
        }
      },
      "MajeurGovernanceBackend": {
        "type": "object",
        "required": [
          "governance_mode",
          "governance_chain",
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
          "governance_chain": {
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
            "$ref": "#/components/schemas/GovernanceVerificationState"
          },
          "governance_display_label": {
            "type": "string",
            "nullable": true
          },
          "governance_attached_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "governance_last_verified_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "governance_metadata": {
            "$ref": "#/components/schemas/MajeurGovernanceMetadata"
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
            "self",
            "zkpassport"
          ],
          "nationality": [
            "self",
            "zkpassport"
          ],
          "gender": [
            "self",
            "zkpassport"
          ],
          "wallet_score": [
            "passport"
          ],
          "sanctions_clear": [
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
              "sanctions_clear",
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
            "items": {
              "type": "string",
              "enum": [
                "self",
                "zkpassport",
                "very",
                "passport"
              ]
            }
          },
          "accepted_mechanisms": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string"
            }
          },
          "config": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          }
        }
      },
      "CommunityPricingAdjustmentType": {
        "type": "string",
        "enum": [
          "multiplier"
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
      "CommunitySaleAllocationRecipientType": {
        "type": "string",
        "enum": [
          "creator",
          "performer",
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
      "GateTraceNode": {
        "type": "object",
        "required": [
          "kind",
          "passed"
        ],
        "additionalProperties": true,
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "op",
              "gate"
            ]
          },
          "op": {
            "type": "string",
            "enum": [
              "and",
              "or"
            ]
          },
          "gate_type": {
            "type": "string"
          },
          "provider": {
            "type": "string"
          },
          "passed": {
            "type": "boolean"
          },
          "reason": {
            "type": "string"
          },
          "required_score": {
            "type": "number",
            "nullable": true
          },
          "actual_score": {
            "type": "number",
            "nullable": true
          },
          "required_age": {
            "type": "integer",
            "nullable": true
          },
          "children": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": true
            }
          }
        }
      },
      "RequiredActionSet": {
        "type": "object",
        "required": [
          "kind",
          "mode",
          "items"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "set"
            ]
          },
          "mode": {
            "type": "string",
            "enum": [
              "all",
              "any"
            ]
          },
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/RequiredActionNode"
            }
          }
        }
      },
      "LiveRoomReplayAllocation": {
        "type": "object",
        "required": [
          "id",
          "participant_user",
          "external_party_ref",
          "role",
          "share_bps",
          "rights_basis",
          "approval_status"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "participant_user": {
            "type": "string",
            "nullable": true
          },
          "external_party_ref": {
            "type": "string",
            "nullable": true
          },
          "role": {
            "type": "string"
          },
          "share_bps": {
            "type": "integer",
            "minimum": 0,
            "maximum": 10000
          },
          "rights_basis": {
            "type": "string"
          },
          "approval_status": {
            "type": "string",
            "enum": [
              "pending",
              "approved",
              "rejected"
            ]
          }
        }
      },
      "LiveRoomRecordingRawArtifact": {
        "type": "object",
        "required": [
          "provider",
          "ipfs_cid",
          "mime_type",
          "size_bytes"
        ],
        "properties": {
          "provider": {
            "type": "string",
            "enum": [
              "filebase",
              "agora_capture"
            ]
          },
          "ipfs_cid": {
            "type": "string",
            "nullable": true
          },
          "mime_type": {
            "type": "string"
          },
          "size_bytes": {
            "type": "integer",
            "format": "int64"
          }
        }
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
      "XPostEmbed": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "embed",
          "embed_key",
          "provider",
          "canonical_url",
          "original_url",
          "state"
        ],
        "properties": {
          "embed": {
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
            "$ref": "#/components/schemas/XEmbedPreview",
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
      },
      "YouTubeVideoEmbed": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "embed",
          "embed_key",
          "provider",
          "canonical_url",
          "original_url",
          "state"
        ],
        "properties": {
          "embed": {
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
            "$ref": "#/components/schemas/YouTubeEmbedPreview",
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
      },
      "KalshiMarketEmbed": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "embed",
          "embed_key",
          "provider",
          "canonical_url",
          "original_url",
          "state"
        ],
        "properties": {
          "embed": {
            "type": "string"
          },
          "embed_key": {
            "type": "string"
          },
          "provider": {
            "type": "string",
            "enum": [
              "kalshi"
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
            "$ref": "#/components/schemas/PredictionMarketEmbedPreview",
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
      },
      "PolymarketMarketEmbed": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "embed",
          "embed_key",
          "provider",
          "canonical_url",
          "original_url",
          "state"
        ],
        "properties": {
          "embed": {
            "type": "string"
          },
          "embed_key": {
            "type": "string"
          },
          "provider": {
            "type": "string",
            "enum": [
              "polymarket"
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
            "$ref": "#/components/schemas/PredictionMarketEmbedPreview",
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
            "type": "integer",
            "format": "int64",
            "nullable": true
          }
        }
      },
      "CrosspostSourceStatus": {
        "type": "string",
        "enum": [
          "available",
          "deleted",
          "removed",
          "unavailable"
        ]
      },
      "SongStreakLeaderboardIdentity": {
        "type": "object",
        "required": [
          "user_id"
        ],
        "properties": {
          "user_id": {
            "type": "string"
          },
          "handle": {
            "type": "string",
            "nullable": true
          },
          "display_name": {
            "type": "string",
            "nullable": true
          },
          "avatar_ref": {
            "type": "string",
            "nullable": true
          }
        },
        "additionalProperties": false
      },
      "ModerationCasePostPreview": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "post_id",
          "post_type",
          "status",
          "title",
          "body",
          "caption",
          "media_refs_json",
          "author_handle"
        ],
        "properties": {
          "post_id": {
            "type": "string"
          },
          "post_type": {
            "type": "string"
          },
          "status": {
            "type": "string"
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
          "media_refs_json": {
            "type": "string",
            "nullable": true
          },
          "author_handle": {
            "type": "string",
            "nullable": true
          }
        }
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
      "ModerationSignalSeverity": {
        "type": "string",
        "enum": [
          "low",
          "medium",
          "high"
        ]
      },
      "ModerationCaseOpenedBy": {
        "type": "string",
        "enum": [
          "platform_analysis",
          "user_report",
          "mixed"
        ]
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
            "type": "string"
          },
          "liquidity_score": {
            "type": "string",
            "nullable": true
          },
          "resolve_date": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "market_url": {
            "type": "string",
            "format": "uri"
          },
          "snapshot_at": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "NotificationEvent": {
        "type": "object",
        "required": [
          "id",
          "object",
          "type",
          "actor_user",
          "subject_type",
          "subject",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "notification_event"
            ]
          },
          "type": {
            "$ref": "#/components/schemas/NotificationEventType"
          },
          "actor_user": {
            "type": "string",
            "nullable": true
          },
          "subject_type": {
            "type": "string"
          },
          "subject": {
            "type": "string"
          },
          "object_type": {
            "type": "string",
            "nullable": true
          },
          "payload": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "NotificationReceipt": {
        "type": "object",
        "required": [
          "id",
          "object",
          "recipient_user",
          "created"
        ],
        "properties": {
          "id": {
            "type": "string",
            "readOnly": true
          },
          "object": {
            "type": "string",
            "readOnly": true,
            "enum": [
              "notification_receipt"
            ]
          },
          "recipient_user": {
            "type": "string"
          },
          "seen_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "read_at": {
            "type": "integer",
            "format": "int64",
            "nullable": true
          },
          "created": {
            "type": "integer",
            "format": "int64"
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
      "SelfVerificationDisclosures": {
        "type": "object",
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
      "VerySessionBinding": {
        "type": "object",
        "required": [
          "uniqueness_domain",
          "binding_value",
          "challenge_expires_at"
        ],
        "properties": {
          "uniqueness_domain": {
            "type": "string"
          },
          "binding_value": {
            "type": "string"
          },
          "binding_field": {
            "type": "string",
            "enum": [
              "pseudonym",
              "challenge"
            ],
            "nullable": true
          },
          "challenge_expires_at": {
            "type": "integer",
            "format": "int64"
          }
        }
      },
      "NamespaceAttachmentInput": {
        "type": "object",
        "required": [
          "namespace_verification"
        ],
        "properties": {
          "namespace_verification": {
            "type": "string"
          },
          "display_label": {
            "type": "string"
          },
          "normalized_label": {
            "type": "string"
          },
          "resolver_label": {
            "type": "string",
            "nullable": true
          },
          "route_family": {
            "type": "string",
            "nullable": true
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
            ]
          },
          "pricing_model": {
            "type": "string",
            "enum": [
              "free",
              "flat_by_length",
              "custom_curve",
              "gated_then_flat"
            ],
            "nullable": true
          }
        }
      },
      "CreateCommunityDonationPolicyInput": {
        "type": "object",
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
          "donation_partner": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CreateCommunityContentAuthenticityPolicyInput": {
        "type": "object",
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
            "$ref": "#/components/schemas/CommunityContentAuthenticityStance"
          },
          "text_policy": {
            "$ref": "#/components/schemas/CommunityTextAuthenticityPolicySettings"
          },
          "image_policy": {
            "$ref": "#/components/schemas/CommunityImageAuthenticityPolicySettings"
          },
          "video_policy": {
            "$ref": "#/components/schemas/CommunityVideoAuthenticityPolicySettings"
          },
          "song_policy": {
            "$ref": "#/components/schemas/CommunitySongAuthenticityPolicySettings"
          }
        }
      },
      "CreateCommunitySourcePolicyInput": {
        "type": "object",
        "required": [
          "identified_person_media_scope",
          "require_source_url_for_reposts",
          "allow_human_made_fan_art_of_real_people",
          "require_fan_art_disclosure"
        ],
        "additionalProperties": false,
        "properties": {
          "identified_person_media_scope": {
            "$ref": "#/components/schemas/CommunityIdentifiedPersonMediaScope"
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
      "CreateCommunityCaptureEditPolicyInput": {
        "type": "object",
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
            "$ref": "#/components/schemas/CommunityDisclosureDecisionLevel"
          },
          "retouching": {
            "$ref": "#/components/schemas/CommunityDisclosureDecisionLevel"
          },
          "compositing": {
            "$ref": "#/components/schemas/CommunityDisclosureDecisionLevel"
          },
          "documentary_editing": {
            "$ref": "#/components/schemas/CommunityDisclosureDecisionLevel"
          },
          "require_edit_disclosure": {
            "type": "boolean"
          }
        }
      },
      "CreateCommunityAdultContentPolicyInput": {
        "type": "object",
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
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "artistic_nudity": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "explicit_nudity": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "explicit_sexual_content": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "fetish_content": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          }
        }
      },
      "CreateCommunityGraphicContentPolicyInput": {
        "type": "object",
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
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "gore": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "extreme_gore": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "body_horror_disturbing": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "animal_harm": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          }
        }
      },
      "CreateCommunityMotionMediaPolicyInput": {
        "type": "object",
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
      "CreateCommunityLanguagePolicyInput": {
        "type": "object",
        "required": [
          "profanity",
          "slurs"
        ],
        "additionalProperties": false,
        "properties": {
          "profanity": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "slurs": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          }
        }
      },
      "CreateCommunityCivilityPolicyInput": {
        "type": "object",
        "required": [
          "group_directed_demeaning_language",
          "targeted_insults",
          "targeted_harassment",
          "threatening_language"
        ],
        "additionalProperties": false,
        "properties": {
          "group_directed_demeaning_language": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "targeted_insults": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "targeted_harassment": {
            "$ref": "#/components/schemas/CommunityModerationDecisionLevel"
          },
          "threatening_language": {
            "$ref": "#/components/schemas/CommunityEscalationDecisionLevel"
          }
        }
      },
      "CreateCommunityProvenancePolicyInput": {
        "type": "object",
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
              "$ref": "#/components/schemas/CommunityCreatorRelation"
            }
          },
          "require_creator_relation": {
            "type": "boolean"
          },
          "false_claim_consequence": {
            "$ref": "#/components/schemas/CommunityFalseClaimConsequence"
          },
          "allow_oc_claim": {
            "type": "boolean"
          },
          "require_proof_for_original": {
            "type": "boolean"
          }
        }
      },
      "CreateCommunityPromotionPolicyInput": {
        "type": "object",
        "required": [
          "self_promotion_mode",
          "require_affiliation_disclosure"
        ],
        "additionalProperties": false,
        "properties": {
          "self_promotion_mode": {
            "$ref": "#/components/schemas/CommunitySelfPromotionMode"
          },
          "require_affiliation_disclosure": {
            "type": "boolean"
          },
          "max_promotional_posts_per_week": {
            "type": "integer",
            "nullable": true
          },
          "promotional_participation_ratio_decimal": {
            "type": "string",
            "pattern": "^\\d+(\\.\\d+)?$",
            "nullable": true
          },
          "require_minimum_membership_days": {
            "type": "integer",
            "nullable": true
          }
        }
      },
      "CreateCommunityContentAuthenticityDetectionPolicyInput": {
        "type": "object",
        "required": [
          "selection_mode"
        ],
        "additionalProperties": false,
        "properties": {
          "selection_mode": {
            "$ref": "#/components/schemas/CommunityContentAuthenticityDetectionSelectionMode"
          },
          "authenticity_detection_profile": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CreateCommunityMarketContextPolicyInput": {
        "type": "object",
        "required": [
          "mode"
        ],
        "additionalProperties": false,
        "properties": {
          "mode": {
            "$ref": "#/components/schemas/CommunityMarketContextMode"
          },
          "enabled_post_types": {
            "type": "array",
            "nullable": true,
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
                "$ref": "#/components/schemas/CommunityMarketContextProviderSet"
              }
            ],
            "nullable": true
          },
          "market_context_profile": {
            "type": "string",
            "nullable": true
          }
        }
      },
      "CreateCommunityMoneyPolicyInput": {
        "type": "object",
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
              "$ref": "#/components/schemas/CommunityMoneyAssetRef"
            }
          },
          "accepted_source_chains": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CommunityMoneyChainRef"
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
            "$ref": "#/components/schemas/CommunityMoneyChainRef"
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
            "$ref": "#/components/schemas/CommunityFundingRouteStatusPolicy"
          },
          "route_hop_tolerance": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "CreateCommunityBootstrapInput": {
        "type": "object",
        "properties": {
          "label_policy": {
            "$ref": "#/components/schemas/CreateCommunityLabelPolicyInput",
            "nullable": true
          },
          "rules": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CreateCommunityRuleInput"
            }
          },
          "resource_links": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/CreateCommunityResourceLinkInput"
            }
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
              "altcha_pow",
              "erc721_holding",
              "erc721_inventory_match"
            ]
          },
          "proof_requirements": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "#/components/schemas/ProofRequirement"
            }
          },
          "chain_namespace": {
            "type": "string",
            "nullable": true
          },
          "gate_config": {
            "type": "object",
            "nullable": true,
            "additionalProperties": true
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
            "$ref": "#/components/schemas/MajeurSafeConfigInput"
          }
        }
      },
      "GateAtom": {
        "type": "object",
        "required": [
          "type"
        ],
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "unique_human",
              "minimum_age",
              "nationality",
              "gender",
              "wallet_score",
              "altcha_pow",
              "erc721_holding",
              "erc721_inventory_match"
            ]
          },
          "provider": {
            "type": "string",
            "enum": [
              "self",
              "zkpassport",
              "very",
              "passport",
              "courtyard",
              "altcha"
            ],
            "nullable": true
          },
          "accepted_providers": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string",
              "enum": [
                "self",
                "zkpassport"
              ]
            }
          },
          "minimum_age": {
            "type": "integer"
          },
          "allowed": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "minimum_score": {
            "type": "number"
          },
          "chain_namespace": {
            "type": "string"
          },
          "contract_address": {
            "type": "string"
          },
          "min_quantity": {
            "type": "integer"
          },
          "match": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "CommunityAuthenticityDetectionProfileStatus": {
        "type": "string",
        "enum": [
          "active",
          "archived"
        ]
      },
      "MarketContextProfileStatus": {
        "type": "string",
        "enum": [
          "active",
          "archived"
        ]
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
      "RequiredActionNode": {
        "type": "object",
        "required": [
          "kind"
        ],
        "additionalProperties": true,
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "action",
              "set"
            ]
          },
          "mode": {
            "type": "string",
            "enum": [
              "all",
              "any"
            ]
          },
          "items": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": true
            }
          },
          "provider": {
            "type": "string",
            "enum": [
              "self",
              "zkpassport",
              "very",
              "passport",
              "wallet",
              "altcha"
            ]
          },
          "accepted_providers": {
            "type": "array",
            "nullable": true,
            "items": {
              "type": "string",
              "enum": [
                "self",
                "zkpassport"
              ]
            }
          },
          "capability": {
            "type": "string",
            "enum": [
              "minimum_age",
              "nationality",
              "gender",
              "unique_human",
              "wallet_score",
              "altcha_pow",
              "erc721_holding",
              "erc721_inventory_match"
            ]
          },
          "scope": {
            "type": "string"
          },
          "required_age": {
            "type": "integer"
          },
          "allowed_countries": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "allowed_markers": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "M",
                "F"
              ]
            }
          },
          "minimum_score": {
            "type": "number"
          },
          "actual_score": {
            "type": "number",
            "nullable": true
          },
          "chain_namespace": {
            "type": "string"
          },
          "contract_address": {
            "type": "string"
          },
          "min_quantity": {
            "type": "integer"
          }
        }
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
          "created": {
            "type": "string",
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
      "PredictionMarketEmbedPreview": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "question": {
            "type": "string",
            "nullable": true
          },
          "title": {
            "type": "string",
            "nullable": true
          },
          "image_url": {
            "type": "string",
            "nullable": true
          },
          "yes_price": {
            "type": "number",
            "nullable": true
          },
          "yes_bid": {
            "type": "number",
            "nullable": true
          },
          "yes_ask": {
            "type": "number",
            "nullable": true
          },
          "no_bid": {
            "type": "number",
            "nullable": true
          },
          "no_ask": {
            "type": "number",
            "nullable": true
          },
          "last_price": {
            "type": "number",
            "nullable": true
          },
          "volume": {
            "type": "number",
            "nullable": true
          },
          "volume_24h": {
            "type": "number",
            "nullable": true
          },
          "liquidity": {
            "type": "number",
            "nullable": true
          },
          "open_interest": {
            "type": "number",
            "nullable": true
          },
          "status": {
            "type": "string",
            "nullable": true
          },
          "resolution": {
            "type": "string",
            "enum": [
              "yes",
              "no"
            ],
            "nullable": true
          },
          "resolved_outcome": {
            "type": "string",
            "nullable": true
          },
          "close_time": {
            "type": "string",
            "nullable": true
          },
          "updated_at": {
            "type": "string",
            "nullable": true
          },
          "chart": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "#/components/schemas/PredictionMarketChartPoint"
            }
          },
          "outcomes": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "#/components/schemas/PredictionMarketOutcome"
            }
          }
        }
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
              "$ref": "#/components/schemas/CreateCommunityLabelDefinitionInput"
            }
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
      "PredictionMarketChartPoint": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ts"
        ],
        "properties": {
          "ts": {
            "type": "integer",
            "format": "int64"
          },
          "price": {
            "type": "number",
            "nullable": true
          },
          "volume": {
            "type": "number",
            "nullable": true
          },
          "open_interest": {
            "type": "number",
            "nullable": true
          }
        }
      },
      "PredictionMarketOutcome": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "label",
          "probability"
        ],
        "properties": {
          "label": {
            "type": "string"
          },
          "probability": {
            "type": "number"
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
      }
    }
  }
} as const

export default spec
