# Forge documentation

This directory describes the system that exists now. It is not a diary of
past architectures and it does not present planned work as shipped behavior.
Git history is the archive for retired designs.

Read in this order:

1. [Product direction](PRODUCT.md) — product promise, boundaries and decisions.
2. [Architecture](ARCHITECTURE.md) — ownership and runtime flow.
3. [Guardrails](GUARDRAILS.md) — what Forge constrains and why.
4. [Plugin platform](INTERNAL-PLUGINS.md) — how built-in and user-installed capabilities attach.
5. [Harness reliability](RELIABILITY.md) — event-derived kernel measurements.
6. [Engineering standards](ENGINEERING-STANDARDS.md) — change contract and boundary checklist.
7. [Development](DEVELOPMENT.md) — local workflow and verification.
8. [Web Server release](WEB-RELEASE.md) — installation and distribution.

The repository-wide rules in [`AGENTS.md`](../AGENTS.md) are authoritative when
they conflict with prose here. `docs/capability-seams.md` is generated from the
registry; regenerate it with `npm run gen:seams` rather than editing it.

## Product position

Forge on `main` is a local Web Server engineering-agent platform. Built-in and user-installed
capabilities share the same Forge attachment points. Openness means a documented
Forge contract and explicit local/Git installation; it does not mean a central
marketplace or compatibility with another agent framework.

The LLM supplies judgment. Forge supplies behavioral constraints, durable
records, recovery and a complete browser workbench.
