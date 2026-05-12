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
                "comment_create"
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
                          },
                          "membership_mode": {
                            "type": "string",
                            "enum": [
                              "open",
                              "request",
                              "gated"
                            ]
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
                              "$ref": "./agents.yaml#/AgentOwnershipProvider"
                            }
                          },
                          "membership_gate_summaries": {
                            "type": "array",
                            "items": {
                              "$ref": "./communities-core.yaml#/MembershipGateSummary"
                            }
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
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "BadRequest": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "RateLimited": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "NotFound": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "Conflict": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "Forbidden": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "EligibilityFailed": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "GateFailed": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "VerificationRequired": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "AnalysisBlocked": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
            }
          }
        }
      },
      "PostingQuotaExhausted": {
        "content": {
          "application/json": {
            "schema": {
              "$ref": "./schemas/common.yaml#/Error"
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
            "items": {
              "$ref": "./auth.yaml#/WalletAttachmentSummary"
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
              "very"
            ]
          },
          "provider_mode": {
            "type": "string",
            "enum": [
              "qr_deeplink",
              "widget"
            ],
            "nullable": true
          },
          "requested_capabilities": {
            "type": "array",
            "minItems": 1,
            "items": {
              "$ref": "./verification.yaml#/RequestedVerificationCapability"
            }
          },
          "verification_requirements": {
            "type": "array",
            "nullable": true,
            "items": {
              "$ref": "./verification.yaml#/VerificationRequirement"
            }
          },
          "wallet_attachment": {
            "type": "string",
            "nullable": true
          },
          "verification_intent": {
            "$ref": "./verification.yaml#/VerificationIntent",
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
              "very"
            ]
          },
          "provider_mode": {
            "type": "string",
            "enum": [
              "qr_deeplink",
              "widget"
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
            "$ref": "./verification.yaml#/VerificationSessionLaunch"
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
            "$ref": "./agents.yaml#/AgentOwnershipSessionKind"
          },
          "ownership_provider": {
            "$ref": "./agents.yaml#/AgentOwnershipProvider"
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
            "$ref": "./agents.yaml#/AgentChallenge"
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
            "$ref": "./agents.yaml#/AgentOwnershipSessionKind"
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
            "$ref": "./agents.yaml#/AgentChallenge"
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
            "$ref": "./agents.yaml#/AgentOwnershipProvider"
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
              "$ref": "./agents.yaml#/UserAgent"
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
            "$ref": "./agents.yaml#/AgentHandle",
            "nullable": true
          },
          "status": {
            "$ref": "./agents.yaml#/UserAgentStatus"
          },
          "current_ownership_record": {
            "type": "string",
            "nullable": true
          },
          "current_ownership": {
            "$ref": "./agents.yaml#/AgentOwnershipRecord",
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
            "$ref": "./agents.yaml#/AgentHandleStatus"
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
                "$ref": "./agents.yaml#/AgentHandle"
              },
              "ownership_provider": {
                "$ref": "./agents.yaml#/AgentOwnershipProvider",
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
            "$ref": "./jobs.yaml#/Job"
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
            "$ref": "./verification.yaml#/VerificationCapabilities"
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
            "nullable": true
          },
          "xmtp_inbox": {
            "type": "string",
            "nullable": true
          },
          "verification_capabilities": {
            "allOf": [
              {
                "$ref": "./verification.yaml#/VerificationCapabilities"
              }
            ],
            "nullable": true
          },
          "global_handle": {
            "$ref": "./profiles.yaml#/GlobalHandle"
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
            "$ref": "./communities-core.yaml#/Community"
          },
          "job": {
            "$ref": "./jobs.yaml#/Job"
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
            "$ref": "./communities-core.yaml#/HumanVerificationLane"
          },
          "human_verification_lane_origin": {
            "$ref": "./communities-core.yaml#/CommunityAgentResolutionOrigin"
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
            ]
          },
          "gate_policy": {
            "$ref": "./communities-core.yaml#/GatePolicy",
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
          "guest_comment_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "altcha_required"
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
              "$ref": "./agents.yaml#/AgentOwnershipProvider"
            }
          },
          "accepted_agent_ownership_providers_origin": {
            "$ref": "./communities-core.yaml#/CommunityAgentResolutionOrigin"
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
            "$ref": "./communities-community.yaml#/DonationPartnerSummary",
            "nullable": true
          },
          "money_policy": {
            "$ref": "./communities-community.yaml#/CommunityMoneyPolicy"
          },
          "content_authenticity_policy": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityPolicy"
          },
          "content_authenticity_detection_policy": {
            "$ref": "./communities-community.yaml#/CommunityContentAuthenticityDetectionPolicy"
          },
          "market_context_policy": {
            "$ref": "./market-context.yaml#/CommunityMarketContextPolicy"
          },
          "source_policy": {
            "$ref": "./communities-community.yaml#/CommunitySourcePolicy"
          },
          "capture_edit_policy": {
            "$ref": "./communities-community.yaml#/CommunityCaptureEditPolicy"
          },
          "adult_content_policy": {
            "$ref": "./communities-community.yaml#/CommunityAdultContentPolicy"
          },
          "graphic_content_policy": {
            "$ref": "./communities-community.yaml#/CommunityGraphicContentPolicy"
          },
          "motion_media_policy": {
            "$ref": "./communities-community.yaml#/CommunityMotionMediaPolicy"
          },
          "language_policy": {
            "$ref": "./communities-community.yaml#/CommunityLanguagePolicy"
          },
          "civility_policy": {
            "$ref": "./communities-community.yaml#/CommunityCivilityPolicy"
          },
          "visual_policy_settings": {
            "$ref": "./communities-core.yaml#/CommunityVisualPolicySettings"
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
            "$ref": "./communities-community.yaml#/CommunityProvenancePolicy"
          },
          "promotion_policy": {
            "$ref": "./communities-community.yaml#/CommunityPromotionPolicy"
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
            "$ref": "./communities-community.yaml#/CommunityPolicyOrigin"
          },
          "pricing_policy_version": {
            "type": "string"
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
              "$ref": "./communities-community.yaml#/CommunityListing"
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
              "$ref": "./communities-community.yaml#/CommunityPurchase"
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
            "$ref": "./communities-community.yaml#/CommunityPricingVerificationProvider",
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
            "type": "boolean"
          },
          "route_live_available": {
            "type": "boolean",
            "nullable": true
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
              "$ref": "./communities-core.yaml#/MembershipRequestSummary"
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
            "$ref": "./communities-core.yaml#/MembershipRequestStatus"
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
          "guest_comment_policy": {
            "type": "string",
            "enum": [
              "disallow",
              "altcha_required"
            ]
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
              "$ref": "./agents.yaml#/AgentOwnershipProvider"
            }
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
                "wallet_score",
                "altcha_pow"
              ]
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
            "$ref": "./communities-core.yaml#/GatePolicyEvaluation",
            "nullable": true
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
          "agent": {
            "type": "string",
            "nullable": true
          },
          "agent_action_proof": {
            "$ref": "./agents.yaml#/AgentActionProof",
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
            "nullable": true
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
            "$ref": "./posts.yaml#/PromotionDisclosureInput",
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
              "$ref": "./posts.yaml#/DisclosedQualifierSnapshot"
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
              "$ref": "./posts.yaml#/PostEmbed"
            },
            "nullable": true
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
          "anchor_live_room": {
            "type": "string",
            "nullable": true,
            "readOnly": true
          },
          "song_title": {
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
              "$ref": "./posts.yaml#/MediaDescriptor"
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
            "$ref": "./agents.yaml#/AgentActionProof",
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
            "$ref": "./agents.yaml#/AgentOwnershipProvider",
            "nullable": true
          },
          "body": {
            "type": "string",
            "nullable": true
          },
          "media_refs": {
            "type": "array",
            "items": {
              "$ref": "./posts.yaml#/MediaDescriptor"
            }
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
            "$ref": "./moderation.yaml#/UserReportReasonCode"
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
            "$ref": "./moderation.yaml#/UserReportReasonCode"
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
              "$ref": "./moderation.yaml#/ModerationCaseListItem"
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
              "$ref": "./song-artifacts.yaml#/SongArtifactBundle"
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
            "$ref": "./song-artifacts.yaml#/SongArtifactUploadRef"
          },
          "title": {
            "type": "string"
          },
          "lyrics": {
            "type": "string"
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
            "$ref": "./song-artifacts.yaml#/SongAudioArtifactDescriptor"
          },
          "media_refs": {
            "type": "array",
            "items": {
              "$ref": "./posts.yaml#/MediaDescriptor"
            }
          },
          "lyrics": {
            "type": "string"
          },
          "lyrics_sha256": {
            "type": "string"
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
          "created": {
            "type": "integer",
            "format": "int64"
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
              "$ref": "./posts.yaml#/LocalizedPostEmbedTranslation"
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
              "$ref": "./notifications.yaml#/UserTask"
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
              "$ref": "./notifications.yaml#/NotificationFeedItem"
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
            "$ref": "./notifications.yaml#/UserTaskType"
          },
          "subject_type": {
            "type": "string"
          },
          "subject": {
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
              "$ref": "./communities-community.yaml#/StructuredPostCard"
            }
          },
          "next_cursor": {
            "type": "string",
            "nullable": true
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
          "next_cursor",
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
          "next_cursor": {
            "type": "string",
            "nullable": true
          },
          "top_comments_limit": {
            "type": "integer",
            "minimum": 0
          },
          "links": {
            "$ref": "./communities-community.yaml#/StructuredAccessLinks"
          }
        }
      }
    }
  }
} as const

export default spec
