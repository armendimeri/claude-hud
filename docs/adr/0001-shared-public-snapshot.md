# 0001 Share one public snapshot across HUD views

Status: accepted 2026-11-27 · From plan `hud-architecture` (see Git history)

## Context

The HUD served a single browser layout from an inline script and collected data in the
same entry file. Adding a view required reaching into transport, projection and DOM
code. The dashboard also has an installed CLI, a standalone Windows hook and users
consuming the same JSON and SSE payloads.

## Decision

Keep Node 22 and native ES modules. The runtime owns collection and transitions.
It publishes one redacted snapshot for the HTTP/SSE adapter. Browser entry points
use one shared store, and view descriptors mount into either the session panel or
the page outlet. Activity demonstrates the page outlet with demo data and a URL
selection. Ship the complete module and asset tree with the two root entry scripts.

## Consequences

Adding a view requires a module, a registry entry and public asset registration.
Views use selectors and subscribe to the store. The existing JSON and SSE formats,
hook paths and CLI entry points remain the deployment contract. Verify changes on
isolated profiles and compare resource use with an equivalent workload.
[Architecture guide](../ARCHITECTURE.md)
