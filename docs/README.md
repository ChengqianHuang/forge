# Forge documentation

This directory describes the system that exists now. It is not a diary of
past architectures and it does not present planned work as shipped behavior.
Git history is the archive for retired designs.

Read in this order:

1. [Product direction](PRODUCT.md) — product promise, boundaries and decisions.
2. [Architecture](ARCHITECTURE.md) — ownership and runtime flow.
3. [Guardrails](GUARDRAILS.md) — what Forge constrains and why.
4. [Internal plugins](INTERNAL-PLUGINS.md) — how Forge-owned capabilities attach.
5. [Development](DEVELOPMENT.md) — change discipline and verification.

The repository-wide rules in [`AGENTS.md`](../AGENTS.md) are authoritative when
they conflict with prose here.

## Product position

Forge is a desktop engineering-agent platform. “Platform” means its own
capabilities share stable internal attachment points; it does not mean a
third-party plugin marketplace or a compatibility clone of another harness.

The LLM supplies judgment. Forge supplies behavioral constraints, durable
records, recovery and a complete desktop workbench.
