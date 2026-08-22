// Generated from harness/contracts/contract.schema.json — do not hand-edit.
// Regenerate via `bun run generate` (or `bun run generate` in packages/contracts).
// Draft 2020-12 JSON Schema; the ingest ajv validator and the Schema Registry
// subject both derive from this artifact (docs/control-plane.md §8.1).

export const eventSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autosploit.dev/schemas/events.json",
  "title": "autosploit harness event",
  "type": "object",
  "properties": {
    "ts": {
      "type": "string",
      "format": "date-time"
    },
    "type": {
      "enum": [
        "phase",
        "tool_call",
        "tool_result",
        "finding",
        "cost",
        "refusal",
        "halt"
      ]
    },
    "data": {
      "type": "object"
    }
  },
  "required": [
    "ts",
    "type",
    "data"
  ],
  "additionalProperties": false,
  "allOf": [
    {
      "if": {
        "properties": {
          "type": {
            "const": "phase"
          }
        },
        "required": [
          "type"
        ]
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "properties": {
              "attempt": {
                "type": "integer"
              },
              "cause": {
                "type": "string"
              },
              "host": {
                "type": "string"
              },
              "nudges": {
                "type": "integer"
              },
              "ports": {},
              "reasoning": {
                "type": "string"
              },
              "stage": {
                "type": "string"
              },
              "summary": {
                "type": "string"
              }
            },
            "required": [
              "stage"
            ]
          }
        },
        "required": [
          "data"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "tool_call"
          }
        },
        "required": [
          "type"
        ]
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "properties": {
              "args": {
                "type": "object"
              },
              "id": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "name": {
                "type": "string"
              }
            },
            "required": [
              "id",
              "name"
            ]
          }
        },
        "required": [
          "data"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "tool_result"
          }
        },
        "required": [
          "type"
        ]
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "properties": {
              "error": {
                "type": "string"
              },
              "id": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "is_error": {
                "type": "boolean"
              },
              "name": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "truncated": {
                "type": "boolean"
              }
            },
            "required": [
              "id",
              "is_error",
              "name"
            ]
          }
        },
        "required": [
          "data"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "finding"
          }
        },
        "required": [
          "type"
        ]
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "properties": {
              "evidence": {
                "type": "string"
              },
              "id": {
                "type": "string"
              },
              "repro": {
                "type": "string"
              },
              "severity": {
                "type": "string"
              },
              "title": {
                "type": "string"
              }
            },
            "required": [
              "evidence",
              "id",
              "repro",
              "severity",
              "title"
            ]
          }
        },
        "required": [
          "data"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "cost"
          }
        },
        "required": [
          "type"
        ]
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "properties": {
              "caps": {
                "type": "object"
              },
              "tokens": {
                "type": "integer"
              },
              "tool_calls": {
                "type": "integer"
              },
              "turn": {
                "type": "object"
              },
              "usd": {
                "type": "number"
              }
            },
            "required": [
              "caps",
              "tokens",
              "tool_calls",
              "usd"
            ]
          }
        },
        "required": [
          "data"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "refusal"
          }
        },
        "required": [
          "type"
        ]
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "properties": {
              "model": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "reason": {
                "type": "string"
              }
            },
            "required": [
              "reason"
            ]
          }
        },
        "required": [
          "data"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "type": {
            "const": "halt"
          }
        },
        "required": [
          "type"
        ]
      },
      "then": {
        "properties": {
          "data": {
            "type": "object",
            "properties": {
              "caps": {
                "type": "object"
              },
              "cause": {
                "type": "string"
              },
              "reason": {
                "type": "string"
              },
              "stage": {
                "type": "string"
              },
              "tokens": {
                "type": "integer"
              },
              "tool_calls": {
                "type": "integer"
              },
              "usd": {
                "type": "number"
              }
            }
          }
        },
        "required": [
          "data"
        ]
      }
    }
  ]
} as const;

