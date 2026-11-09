export const CANARY = "canary-7f3e9b2c";

const s = (key: string, value: string) => ({ key, value: { stringValue: value } });
const nanos = (iso: string) => `${Date.parse(iso)}000000`;

const resource = (service: string) => ({
  attributes: [
    s("service.name", service),
    s("user.email", `${CANARY}@example.invalid`),
    s("user.account_uuid", `${CANARY}-account`),
    s("host.arch", "amd64"),
  ],
});

const event = (name: string, at: string, attributes: { key: string; value: object }[]) => ({
  timeUnixNano: nanos(at),
  eventName: name,
  body: { stringValue: name },
  attributes: [s("event.name", name), ...attributes],
});

export function syntheticLogs(claudeSession: string, codexSession: string) {
  return {
    resourceLogs: [
      {
        resource: resource("claude-code"),
        scopeLogs: [
          {
            scope: { name: "com.anthropic.claude_code.events", version: "2.1.0" },
            logRecords: [
              event("claude_code.user_prompt", "2026-10-20T10:00:00Z", [
                s("session.id", claudeSession),
                s("prompt", `please ${CANARY} deploy`),
                s("prompt_length", "24"),
              ]),
              event("claude_code.api_request", "2026-10-20T10:00:05Z", [
                s("session.id", claudeSession),
                s("model", "claude-opus-5-5"),
                s("cost_usd", "0.25"),
                s("duration_ms", "1200"),
              ]),
              event("claude_code.api_request", "2026-10-20T10:00:06Z", [
                s("session.id", claudeSession),
                s("model", "claude-opus-5-5"),
                s("cost_usd", "0.5"),
                s("duration_ms", "3400"),
              ]),
              event("claude_code.api_error", "2026-10-20T10:00:07Z", [
                s("session.id", claudeSession),
                s("status_code", "529"),
                s("error", "overloaded"),
              ]),
              event("claude_code.tool_result", "2026-10-20T10:00:07Z", [
                s("session.id", claudeSession),
                s("tool_name", "Bash"),
                s("success", "false"),
                s("tool_parameters", `{"command":"cat ${CANARY}"}`),
                s("note", `${"x".repeat(300)}${CANARY}`),
              ]),
              {
                ...event("claude_code.user_prompt", "2026-10-20T10:00:08Z", [
                  s("session.id", claudeSession),
                  {
                    key: "nested",
                    value: { kvlistValue: { values: [s("inner", CANARY)] } },
                  },
                ]),
                body: { stringValue: `free text ${CANARY}` },
              },
            ],
          },
        ],
      },
      {
        resource: resource("codex_cli_rs"),
        scopeLogs: [
          {
            scope: { name: "codex_otel" },
            logRecords: [
              event("codex.sse_event", "2026-10-20T10:00:01Z", [
                s("conversation.id", codexSession),
                s("event.kind", "response.output_text.delta"),
                s("delta", CANARY),
              ]),
              event("codex.user_prompt", "2026-10-20T10:00:00Z", [
                s("conversation.id", codexSession),
                s("prompt", CANARY),
              ]),
              event("codex.api_request", "2026-10-20T10:00:02Z", [
                s("conversation.id", codexSession),
                s("duration_ms", "800"),
                s("http.response.status_code", "200"),
              ]),
              event("codex.tool_result", "2026-10-20T10:00:03Z", [
                s("conversation.id", codexSession),
                s("tool_name", "shell"),
                s("success", "true"),
                s("arguments", `{"cmd":"echo ${CANARY}"}`),
                s("output", `${CANARY}\n`),
              ]),
            ],
          },
        ],
      },
    ],
  };
}

export function syntheticMetrics(claudeSession: string) {
  return {
    resourceMetrics: [
      {
        resource: resource("claude-code"),
        scopeMetrics: [
          {
            scope: { name: "com.anthropic.claude_code" },
            metrics: [
              {
                name: "claude_code.cost.usage",
                unit: "USD",
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      timeUnixNano: nanos("2026-10-20T10:00:06Z"),
                      asDouble: 0.75,
                      attributes: [
                        s("session.id", claudeSession),
                        s("user.email", `${CANARY}@example.invalid`),
                      ],
                    },
                  ],
                },
              },
              {
                name: "claude_code.lines_of_code.count",
                exponentialHistogram: { dataPoints: [{ count: "1", sum: 1 }] },
              },
            ],
          },
        ],
      },
    ],
  };
}
