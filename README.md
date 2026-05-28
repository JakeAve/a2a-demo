# A2A Prototype

Deno-based Agent-to-Agent (A2A) prototype: Claude delegates work to Ollama
peers (and back) over HTTP, discovered via a local registry.

## Run

    cp .env.example .env
    # edit ANTHROPIC_API_KEY
    deno task start --agents="sonnet,gemma3"

See `docs/superpowers/specs/2026-05-28-a2a-design.md` for the design.
