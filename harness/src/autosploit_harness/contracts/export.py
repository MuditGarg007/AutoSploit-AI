"""export — the frozen seams as one machine-readable descriptor (docs/harness.md §9 step 5).

`build_contract()` reflects the live Python shapes (event payloads, tool-result
shapes, scope-file format, run-config format, report shape, driver signatures)
into a single JSON-able dict. `write_contract()` dumps it, sorted + stable, to
`contracts/contract.schema.json` — the artifact the TS control plane / provisioner
consume so they plug into the harness without reshaping it.

Reflection, not a hand-written copy, is the point: the descriptor is generated
FROM the code, so it can't quietly disagree with what the harness actually emits.
The golden copy is committed; tests/test_contracts.py regenerates and compares, so
any seam drift fails the build unless the CONTRACT_VERSION is moved on purpose.
"""

from __future__ import annotations

import dataclasses
import inspect
import json
import types
import typing
from pathlib import Path
from typing import Any, get_args, get_origin, get_type_hints

from autosploit_harness.contracts.events import EVENT_PAYLOADS, EventType
from autosploit_harness.contracts.results import (
    CompleteResult,
    FindingId,
    HttpResult,
    ShellResult,
)
from autosploit_harness.contracts.version import CONTRACT_VERSION

# Default artifact location: a repo-root sibling of configs/ and eval/, so the
# cross-language seam lives next to the other run inputs, not buried in src/.
DEFAULT_CONTRACT_PATH = Path(__file__).resolve().parents[3] / "contracts" / "contract.schema.json"

# Event-schema order (docs/harness.md §7). Kept as a list, not sorted, because the
# order is itself documentation — the lifecycle reads top to bottom.
_EVENT_ORDER: tuple[EventType, ...] = (
    "phase",
    "tool_call",
    "tool_result",
    "finding",
    "cost",
    "refusal",
    "halt",
)

_SCALARS = {
    str: "string",
    bool: "boolean",  # before int: bool is a subclass of int
    int: "integer",
    float: "number",
    type(None): "null",
    dict: "object",
    list: "array",
    Any: "any",
}


def _json_type(hint: Any) -> str:
    """Render a Python type hint as a coarse, language-neutral type name.

    Coarse on purpose — the descriptor is a cross-language seam, so it speaks in
    string/integer/number/boolean/object/array/null, not Python specifics. Unions
    render as "a|b" (e.g. a nullable field is "string|null")."""
    if hint in _SCALARS:
        return _SCALARS[hint]
    origin = get_origin(hint)
    if origin in (typing.Union, types.UnionType):
        return "|".join(dict.fromkeys(_json_type(a) for a in get_args(hint)))
    if origin in (list, tuple):
        return "array"
    if origin is dict:
        return "object"
    # Fallback: a plain class we did not special-case.
    return getattr(hint, "__name__", str(hint))


def _typeddict_fields(td: type) -> dict[str, Any]:
    """{required: [...], fields: {name: typename}} for a payload TypedDict."""
    hints = get_type_hints(td)
    required = getattr(td, "__required_keys__", frozenset())
    return {
        "required": sorted(required),
        "fields": {name: _json_type(hint) for name, hint in hints.items()},
    }


def _dataclass_fields(dc: type) -> dict[str, str]:
    """{name: typename} for a (result / report) dataclass, resolving annotations."""
    hints = get_type_hints(dc)
    return {f.name: _json_type(hints[f.name]) for f in dataclasses.fields(dc)}


def build_contract() -> dict[str, Any]:
    """Reflect the frozen seams into one JSON-able descriptor."""
    from autosploit_harness.driver.report import Report
    from autosploit_harness.driver.run import run, run_engagement

    return {
        "contract_version": CONTRACT_VERSION,
        "generated_by": "autosploit_harness.contracts.export.build_contract",
        "note": (
            "Frozen cross-language seam (docs/harness.md §9 step 5). Generated from "
            "the Python shapes; do not hand-edit. Regenerate via "
            "`autosploit-harness contract`."
        ),
        "events": {
            "envelope": {
                "ts": "string (ISO-8601 UTC)",
                "type": list(_EVENT_ORDER),
                "data": "object (per-type payload below)",
            },
            "payloads": {etype: _typeddict_fields(EVENT_PAYLOADS[etype]) for etype in _EVENT_ORDER},
        },
        # tool_result(is_error=false) data extends with one of these (§4).
        "results": {
            "ShellResult": _dataclass_fields(ShellResult),
            "HttpResult": _dataclass_fields(HttpResult),
            "FindingId": _dataclass_fields(FindingId),
            "CompleteResult": _dataclass_fields(CompleteResult),
        },
        # scope.<name>.yaml — the provisioner emits this later (§1, §3).
        "scope_file": {
            "format": "yaml",
            "shape": {"target": {"host": "string", "ports": "array<integer>"}},
        },
        # run.<name>.toml — the run inputs the CLI / control plane pass (§6, §6.2).
        "run_config": {
            "format": "toml",
            "shape": {
                "model": {"id": "string", "reasoning": "string|null", "fallbacks": "array<string>"},
                "budget": {"max_usd": "number", "max_tokens": "integer", "max_tool_calls": "integer"},
                "target": {"scope_file": "string (path, relative to run.toml)"},
                "output": {"dir": "string (path, relative to run.toml)"},
            },
        },
        "report": _dataclass_fields(Report),
        "driver": {
            "run": f"run{inspect.signature(run)}",
            "run_engagement": f"run_engagement{inspect.signature(run_engagement)}",
        },
    }


def to_json(contract: dict[str, Any] | None = None) -> str:
    """Serialize deterministically — sorted keys so the golden is stable."""
    return json.dumps(contract or build_contract(), indent=2, sort_keys=True) + "\n"


def write_contract(path: Path = DEFAULT_CONTRACT_PATH) -> Path:
    """Write the descriptor to `path` (default: contracts/contract.schema.json)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(to_json(), encoding="utf-8")
    return path
