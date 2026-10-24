"""Bounded Hermes 0.21.0 ACP entrypoint for ephemeral Rudder instructions.

This file is embedded into the Rust binary and invoked with Python isolated
mode. It consumes the private instruction from one reserved child environment
variable, installs it only on newly constructed in-memory ACP agents, and then
delegates to Hermes' normal ACP entrypoint. It never writes session history.
"""

import inspect
import os
import sys


_UNSUPPORTED = 78
_MAX_PROMPT_BYTES = 64 * 1024


def _fail_closed():
    print("Hermes ACP instruction adapter is unsupported", file=sys.stderr)
    raise SystemExit(_UNSUPPORTED)


def _install_tool_argument_compat(events, coerce_tool_args):
    """Repair Hermes 0.21's JSON-string argument/formatter boundary in this child.

    The upstream step callback forwards API argument JSON strings to formatters
    expecting dicts. The first read_file then aborts the remaining completions.
    Preserve tool IDs, results, status and ordering; only normalize that argument
    representation using Hermes' own converter. Rust owns projection/persistence.
    """
    original = events.build_tool_complete
    expected = {"tool_call_id", "tool_name", "result", "function_args", "snapshot"}
    if not expected.issubset(inspect.signature(original).parameters):
        _fail_closed()

    def complete_with_typed_args(tool_call_id, tool_name, result=None, function_args=None, snapshot=None):
        return original(
            tool_call_id, tool_name, result=result,
            function_args=coerce_tool_args(function_args) if function_args is not None else None,
            snapshot=snapshot,
        )

    events.build_tool_complete = complete_with_typed_args


def main():
    # Python -I ignores PYTHON* environment variables and the working
    # directory, so disable bytecode writes and add only the Rust-validated
    # installation root before importing Hermes.
    sys.dont_write_bytecode = True
    source_root = os.environ.pop("RUDDER_HERMES_PYTHON_ROOT", "")
    instruction = os.environ.pop("RUDDER_HERMES_EPHEMERAL_SYSTEM_PROMPT", "")
    if not source_root or len(instruction.encode("utf-8")) > _MAX_PROMPT_BYTES:
        _fail_closed()
    sys.path.insert(0, source_root)

    try:
        import hermes_bootstrap

        hermes_bootstrap.harden_import_path(source_root)

        import hermes_cli

        if getattr(hermes_cli, "__version__", None) != "0.21.0":
            _fail_closed()

        from acp_adapter import events
        from acp_adapter.tools import coerce_tool_args

        if events.make_step_cb.__globals__ is not vars(events):
            _fail_closed()
        _install_tool_argument_compat(events, coerce_tool_args)

        from acp_adapter.session import SessionManager

        original_make_agent = SessionManager._make_agent
        params = inspect.signature(original_make_agent).parameters
        expected = {"self", "session_id", "cwd", "model", "requested_provider", "base_url", "api_mode"}
        if not expected.issubset(params):
            _fail_closed()

        def make_agent_with_ephemeral_instruction(self, *args, **kwargs):
            # ACP persistence stores the provider route alongside the transcript.
            # Native Chat selects the Hermes profile in trusted Rust before this
            # child is launched, so a stale persisted route must not override the
            # selected profile after a process restart.  Preserve the session
            # UUID and model, but let Hermes resolve provider/base URL/API mode
            # from the selected profile configuration again.
            kwargs["requested_provider"] = None
            kwargs["base_url"] = None
            kwargs["api_mode"] = None
            agent = original_make_agent(self, *args, **kwargs)
            prior = getattr(agent, "ephemeral_system_prompt", None)
            if prior is not None and not isinstance(prior, str):
                _fail_closed()
            # Preserve profile-provided ephemeral policy while appending the
            # Rudder-resolved Agent instruction. Hermes injects this value at
            # inference time without adding it to persisted conversation
            # messages; setting it after construction also avoids the
            # constructor's diagnostic preview logging it.
            if instruction:
                agent.ephemeral_system_prompt = (
                    f"{prior.rstrip()}\n\n{instruction}"
                    if prior and prior.strip()
                    else instruction
                )
            return agent

        SessionManager._make_agent = make_agent_with_ephemeral_instruction

        from acp_adapter.entry import main as acp_main

        acp_main([])
    except SystemExit:
        raise
    except Exception as exc:
        # Do not print exception strings: imported libraries may include
        # configuration material. The type is enough to distinguish a safe
        # unsupported bootstrap from a normal Hermes child failure.
        print(f"Hermes ACP instruction adapter failed ({type(exc).__name__})", file=sys.stderr)
        raise SystemExit(_UNSUPPORTED) from None


if __name__ == "__main__":
    main()
