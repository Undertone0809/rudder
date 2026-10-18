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


def main():
    # Python -I ignores PYTHON* environment variables and the working
    # directory, so disable bytecode writes and add only the Rust-validated
    # installation root before importing Hermes.
    sys.dont_write_bytecode = True
    source_root = os.environ.pop("RUDDER_HERMES_PYTHON_ROOT", "")
    instruction = os.environ.pop("RUDDER_HERMES_EPHEMERAL_SYSTEM_PROMPT", "")
    if not source_root or not instruction or len(instruction.encode("utf-8")) > _MAX_PROMPT_BYTES:
        _fail_closed()
    sys.path.insert(0, source_root)

    try:
        import hermes_bootstrap

        hermes_bootstrap.harden_import_path(source_root)

        import hermes_cli

        if getattr(hermes_cli, "__version__", None) != "0.21.0":
            _fail_closed()

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


main()
