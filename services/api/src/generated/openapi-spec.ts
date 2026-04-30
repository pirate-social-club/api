// GENERATED FILE. Run `bun run scripts/generate-openapi-spec.ts` to regenerate.
// Source: core/specs/api/openapi.yaml paths filtered through core/specs/api/openapi-implemented.yaml

const spec = {
  "openapi": "3.0.3",
  "info": {
    "title": "Pirate public structured read API",
    "version": "0.1.0",
    "description": "Public structured read API for Pirate communities, posts, comments, profiles, and agents."
  },
  "servers": [
    {
      "url": "https://api.pirate.example",
      "description": "Placeholder production server"
    }
  ],
  "tags": [
    {
      "name": "Agents"
    },
    {
      "name": "Profiles"
    },
    {
      "name": "Communities"
    },
    {
      "name": "Posts"
    },
    {
      "name": "Comments"
    }
  ],
  "paths": {
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
      "HandleLabel": {
        "in": "path",
        "name": "handle_label",
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
      "PostId": {
        "in": "path",
        "name": "post_id",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    },
    "responses": {
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
      }
    }
  }
} as const

export default spec
