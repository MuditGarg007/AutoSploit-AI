# Autosploit — Attack Engine Harness (design)

> **Status: planning / pre-build (2026-08-08).** Design record for the attack
> engine — the agent loop that runs inside the attacker sandbox (`overview.md` §7).
> Built and tested **standalone first**: one machine, one local vulnerable target,
> no auth / queue / microVM / control plane. If the agent can't exploit a known-vuln
> box here, nothing else in the platform matters. This doc specifies that harness and
> its eval rig. The platform-level guarantees it must honor are fixed in `overview.md`
> §7; everything else is the harness's own shape.

---

## 0. Decisions locked

| Decision | Choice | Why |
|----------|--------|-----|
| Harness language | **Python** | Security-tooling ecosystem is Python-native; Anthropic SDK first-class. Control plane is TS later (§9 seam). |
| Agent loop | **LangGraph** | Graph-based orchestration. Interceptor lives as a deterministic node the graph is built around. |
| Tool surface | **Sandboxed shell + few typed tools** | Shell for breadth (nmap/sqlmap/nikto); typed tools (`http_request`, `note_finding`) for clean interception + good events. |
| First benchmark target | **OWASP Juice Shop** | Modern JS app, many vuln classes, docker one-liner, documented solutions to score against. |
| Model | **`deepseek/deepseek-v4-flash` to start, `deepseek/deepseek-v4-pro` on tap** | Frontier-competitive OSS, and they don't refuse authorized offensive-security work the way Claude/GPT cyber classifiers do. Start on Flash (fast, ~$0.07/$0.18 per MTok, 1M ctx); promote to Pro ($0.28/$0.56, deeper reasoning) if the eval rig shows it's needed. OpenRouter = one OpenAI-compatible endpoint, hot-swap DeepSeek / Kimi / GLM by config. |

---

## 1. What the harness is

Six parts, all runnable on one machine:

```
┌─ HARNESS (Python) ──────────────────────────────────────────────┐
│  DRIVER          target config + scope in → run loop → report    │
│     │                                                            │
│  AGENT LOOP      LangGraph: LLM decides next action, adaptive    │
│     │  tool call                                                 │
│  INTERCEPTOR     deterministic gate — scope + budget, fail-closed│
│     │  (allow)                                                   │
│  TOOL LAYER      typed adapters: run_shell · http_request ·      │
│     │            note_finding · engagement_complete              │
│  MEMORY/LEDGER   on-disk: findings, attempt log, tool outputs    │
│  EVENT EMITTER   JSONL stream (phase/tool/finding/cost)          │
└──────────────────────────────────────────────────────────────────┘
        │ attacks (scope-allowed edge only)
   ┌─ TARGET (docker) ── Juice Shop: app + db, exposed ports ──┐
   └────────────────────────────────────────────────────────────┘
```

Standalone stubs of the real platform:
- **Scope allowlist** = hardcoded YAML (target IP + ports), fakes what the provisioner emits later.
- **Event emitter** = JSONL to stdout/file, fakes the SSE gateway.
- **Sandbox** = local docker network + firewall rules, fakes the microVM.

None of these stubs change the harness's public shape — the driver signature, the
scope-file format, and the event schema are the seams the platform plugs into.

---

## 2. LangGraph shape

The loop is a state graph. The **interceptor is its own node** — every tool call routes
through it before the tool node runs. This is the §7 guarantee ("every tool call crosses
a deterministic interceptor, no LLM in that decision, fail-closed") expressed as graph
topology, not as a convention inside the agent's reasoning.

```
        ┌──────────┐
        │  agent   │  LLM turn: reason + emit tool call(s)
        └────┬─────┘
             │ conditional edge
      ┌──────┴───────┐
      │ tool_use?    │──no──▶ END (or engagement_complete)
      └──────┬───────┘
             │ yes
        ┌────▼──────┐
        │interceptor│  scope + budget check. NO LLM. fail-closed.
        └────┬──────┘
        ┌────┴────┐
     allow      deny
        │          │
   ┌────▼───┐   inject tool_result(is_error) "BLOCKED: out of scope"
   │  tools │        │
   └────┬───┘        │
        └─────┬──────┘
              ▼
          back to agent
```

**Why not LangGraph's prebuilt `ToolNode`:** it executes tools directly with no gate.
We wrap it — the interceptor node sits in front and either forwards the call to the tool
node or short-circuits with a `tool_result` carrying `is_error: true`. A denied call still
returns to the agent (so it can adapt), it just never touches a subprocess.

### State (LangGraph `StateGraph` schema)

```python
class EngagementState(TypedDict):
    messages: Annotated[list, add_messages]  # conversation transcript
    scope: ScopeAllowlist                     # immutable for the run
    ledger: Ledger                            # findings + attempt log (on disk)
    budget: BudgetState                       # tokens + tool-call counters
    phase: str                                # emitted, not enforced (adaptive)
```

`scope` is written once by the driver before the graph starts and never mutated —
enforced by making it a frozen dataclass, not by trusting the loop.

---

## 3. The interceptor (the load-bearing gate)

Deterministic, no LLM, fail-closed. Runs before every tool execution.

Checks, in order:
1. **Budget** — token spend and tool-call count under caps? If not → halt the run
   (partial report), don't just block the call.
2. **Scope** — is the call's target inside the allowlist?
   - `http_request(url=...)` → parse the `url` field (structured, no shell parsing),
     check host+port against the allowlist. Clean.
   - `run_shell(cmd=...)` → **not** parsed for scope. Shell can't escape the network:
     the real boundary is the sandbox firewall (default-deny egress, allowlist target
     only, `overview.md` §4.1). Standalone, this is docker network rules. The interceptor
     still budget-gates shell calls and logs them; scope for shell is enforced at the
     network layer, exactly as in production.

**Fail-closed:** any error in the interceptor (malformed call, parse failure, missing
scope field) → deny. Never default-allow.

The distinction is the whole reason for tool surface #1: `http_request` gives the
interceptor a structured `url` to read; shell gives it nothing parseable, so shell's
scope is the firewall's job. Two layers, and neither is the LLM.

---

## 4. Tool layer

Typed adapters. Each wraps a subprocess/HTTP call, returns a structured result, emits a
tool event. Only path to running anything (§7: no ad-hoc shell escapes — even `run_shell`
is a typed adapter, not a raw exec the model reaches directly).

| Tool | Signature | Notes |
|------|-----------|-------|
| `run_shell` | `(cmd: str, timeout: int) -> ShellResult` | Runs in the attacker container (kali-ish: nmap, curl, sqlmap, nikto, ffuf). stdout+stderr+exit code, truncated. Network-scoped by firewall. |
| `http_request` | `(method, url, headers?, body?) -> HttpResult` | Structured HTTP. `url` is the interceptable field. Dashboard shows "GET /api/users" not a blob. |
| `note_finding` | `(title, severity, evidence, repro) -> FindingId` | Structured finding → ledger + finding event. Not a command. |
| `engagement_complete` | `(summary) -> None` | Agent signals done → graph → END → full report. |

Start with these four. Add typed tools (`port_scan`, dedicated `sqli_probe`) only if the
single-agent loop thrashes on shell for a common operation — don't pre-build them.

Truncation matters: tool outputs (nmap scans, big responses) can blow the context window.
Cap each result; on overflow, write full output to the ledger and hand the agent a preview
+ file path it can `run_shell cat` if needed.

---

## 5. Memory / ledger

On-disk, survives the run, is the report source.

- **Findings** — structured list (`note_finding` writes here). The scored artifact.
- **Attempt log** — what was tried, against what, result. Stops the agent re-running the
  same failed probe; feeds "what have I not tried" reasoning.
- **Tool outputs** — raw, addressable by id. Truncated in-context, full on disk.

Context management: the LangGraph transcript grows unbounded over a long engagement.
No server-side compaction here (OpenRouter/OSS models don't offer it) — do it **client-side
in the harness**, layered as the run lengthens:
- **Trim** — drop or truncate stale tool results from the transcript once they're written
  to the ledger. The full output stays on disk, addressable by id.
- **Summarize** — when the transcript nears the model's window, fold older turns into a
  short recap the agent carries forward. The ledger (findings + attempt log) is the durable
  store, so summarization never loses a finding — findings live on disk, not only in
  transcript.

Window is generous: DeepSeek V4 (Flash and Pro) is 1M tokens, so trim/summarize rarely
fires — a single engagement is unlikely to overrun it. Build the ledger + trim hooks anyway
(cheap, and a runaway loop or huge tool dumps can still fill even 1M), but don't over-invest
until the eval rig shows a real engagement approaching the limit. Re-check the window if
swapping to Kimi / GLM.

Termination: `engagement_complete` (agent-driven) **or** budget/scope halt
(interceptor-driven). Both produce a report; the second produces a partial one.

---

## 6. Model gateway

OpenRouter's OpenAI-compatible endpoint under LangGraph. Use `langchain-openai`'s
`ChatOpenAI` pointed at `base_url="https://openrouter.ai/api/v1"` with the OpenRouter key —
LangGraph binds tools and drives the loop through the standard OpenAI function-calling
interface, no Anthropic SDK. A thin gateway wrapper isolates the provider so swapping
DeepSeek → Kimi → GLM is a config line, not a code change.

Defaults (verified against OpenRouter, Aug 2026):
- **Model:** `deepseek/deepseek-v4-flash`. 1M-token context, ~393K max output.
- **Reasoning:** both Flash and Pro accept OpenRouter's `reasoning` effort param
  (`high` / `xhigh`, where `xhigh` = max). Start with `reasoning` off or `high` on Flash for
  cheap/fast turns; raise it, or move to Pro, if the exploit loop needs deeper multi-step
  reasoning. Surface any returned reasoning content to the event stream so the dashboard
  shows thinking, not a silent pause.
- **`max_tokens`:** generous and stream — a tight cap truncates mid-exploit.
- **Fallbacks:** OpenRouter-native model fallback list (DeepSeek → Kimi → GLM) for provider
  outages / rate limits — an availability fallback, not a refusal fallback.

### 6.1 Defensive tool-call handling (engineering, not model distrust)

These models are frontier-competitive at agentic tool use, so this is not "brace for a weak
model" — it's the fail-closed handling any harness that executes tool calls needs. The
interceptor (§3) already gates every call; this is the same gate doing input validation:
1. **Strict tool schemas + validation** — validate every tool call against its schema
   before execution. A malformed call fails closed → `tool_result(is_error)` with a
   corrective message ("invalid arguments for `http_request`: url required"), returned to
   the agent to retry. Never execute a half-parsed call. This is a security property, not a
   model workaround — it holds no matter how good the model is.
2. **Prose-instead-of-tool nudge** — if the model answers in text when a tool was expected,
   nudge it back with a system reminder rather than ending the turn.
3. **Loop/repeat guard** — the attempt log (§5) records tried calls; the interceptor can
   reject an identical repeated call and tell the agent to try something else. Doubles as
   the runaway-loop guard.
4. **Provider-policy refusals** — some OpenRouter upstreams apply their own moderation.
   Handle a refusal/empty completion as a run event, emit it, fall to the next model in the
   list. Far lower probability than Claude on offensive work, but not zero.

**Open question for the eval rig:** measure tool-call success rate (well-formed, valid,
executed) and exploit score per model on Juice Shop. Flash first; if it under-delivers on
multi-step exploits, compare Pro / Kimi / GLM — the OpenRouter swap makes this a config
sweep, not a rewrite. Decide from data.

### 6.2 Budget metering

Interceptor enforces caps; gateway measures. OpenRouter returns per-response `usage`
(`prompt_tokens`, `completion_tokens`) and its `/generation` endpoint gives the exact USD
cost of a call. Flash is ~$0.07/$0.18 per MTok, Pro ~$0.28/$0.56 — an order of magnitude
under Claude, so budget caps can be generous. Read cost from OpenRouter's usage rather than
hardcoding (prices move). Track:
- token + USD cost (the billing basis reused as the per-user quota later, `overview.md` §8),
- tool-call count (a cheap runaway-loop guard independent of tokens).

Emit a `cost` event each turn. Same budget primitive the platform meters on — build it into
the harness, not bolted on.

---

## 7. Event stream

The one seam the dashboard depends on (§7). Standalone = JSONL; production = SSE gateway.
Same schema either way.

```json
{"ts": "...", "type": "phase|tool_call|tool_result|finding|cost|refusal|halt", "data": {...}}
```

- `phase` — agent's self-declared stage (recon/exploit/...). Emitted, never enforced —
  the loop is adaptive (§7).
- `tool_call` / `tool_result` — typed, per action. Clean because of tool surface #1.
- `finding` — structured, from `note_finding`.
- `cost` — token + tool-call running totals.
- `refusal` / `halt` — the loop stopped and why (cyber refusal, budget, scope, complete).

The driver writes these; the TS control plane later consumes the same JSONL/SSE. Freeze
this schema early — it's the contract two languages meet at.

---

## 8. Test rig / eval

The driver **is** the eval harness — same code, scored targets.

1. `docker compose up` Juice Shop (app + db) on a local network.
2. Firewall rules: attacker container reaches target only (default-deny else) — fakes
   §4.1 egress locking.
3. Hardcoded scope YAML: target IP + exposed ports.
4. Run the loop.
5. Score against Juice Shop's documented solutions:
   - **Found** the planted vuln class? **Exploited** it (not just flagged)?
   - **Cost** (tokens + $), **step count**, **wall time**.
   - **False positives** (findings that don't hold up).
   - **Tool-call success rate** (well-formed + valid + executed) — the §6.1 risk metric;
     drives the DeepSeek/Kimi/GLM model choice.

Metrics land in the ledger + events, so scoring reads the same artifacts the dashboard
would. Add DVWA / a custom minimal-vuln app later for cleaner planted-vuln signal.

---

## 9. Build order

1. **Skeleton loop** — LangGraph graph, one tool (`run_shell`), interceptor node
   (budget only), JSONL events. Point at Juice Shop. Prove the graph runs a tool and
   comes back.
2. **Full tool surface** — add `http_request` (+ real scope check), `note_finding`,
   `engagement_complete`. Ledger on disk.
3. **Model gateway hardening** — OpenRouter wrapper, strict tool-schema validation +
   malformed-call recovery, loop guard, budget/cost metering, availability fallback list.
4. **Eval rig** — scoring against Juice Shop solutions; run the model sweep
   (DeepSeek / Kimi / GLM); decide primary from tool-call-success + score data.
5. **Freeze the seams** — scope-file format, event schema, driver signature — so the
   control plane (TS) and provisioner plug in without reshaping the harness. *Built:*
   the per-type event `data` payloads are pinned as TypedDicts in
   `contracts/events.py` (was an open `dict[str, Any]`); `contracts/version.py` carries
   the `CONTRACT_VERSION` compat handle, stamped into each run's `manifest.json`;
   `contracts/export.py` reflects the live shapes (event payloads, tool-result shapes,
   scope-file + run-config formats, report shape, driver signatures) into one
   machine-readable descriptor, `contracts/contract.schema.json` — the artifact the TS
   side consumes. `autosploit-harness contract` regenerates it; `tests/test_contracts.py`
   fails the build on any drift, so a seam only moves when `CONTRACT_VERSION` moves on
   purpose. `contracts/events.validate_event()` enforces the frozen shape at runtime.

Only after the loop demonstrably exploits Juice Shop does any of `overview.md`'s control
plane / isolation / orchestration work begin.

---

## 10. Open questions

- **Primary model:** Flash first; escalate to Pro / Kimi / GLM only if §8 score data
  demands it. OpenRouter makes it a config sweep, not a rewrite.
- **Reasoning effort:** does `reasoning: high`/`xhigh` on Flash improve exploit success
  enough to justify the token cost, or is Pro the better spend when depth is needed? Sweep.
- **Tool surface growth:** ship the four in §4; promote `port_scan` / `sqli_probe` to
  typed tools only if the loop measurably bottlenecks on shell for them.
- **Context strategy at length:** client-side trim vs summarize vs ledger-only — pick when a
  real engagement first overruns the (model-specific) window, not speculatively.
- **Single agent vs planner/executor split:** start single-agent (this doc). Add a planner
  or subagents only if one agent thrashes on multi-step exploits — and OSS models are
  weaker at delegation than frontier Claude, so don't assume subagents come free.
