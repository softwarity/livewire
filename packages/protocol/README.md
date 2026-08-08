# @softwarity/livewire-protocol

The wire contract shared by every Livewire implementation: the frame types, and
**[SPEC.md](./SPEC.md)** — which is the normative part.

This package emits no runtime code. Servers and clients depend on it for types
only, so the contract lives in one place instead of being copied into each side
and versioned by convention.

Read `SPEC.md` before implementing a server. TypeScript can describe the shape
of a frame; it cannot say *an unchanged window publishes nothing*, and that rule
is as much part of the contract as the shape.
