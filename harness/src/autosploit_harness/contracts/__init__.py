"""contracts — THE SEAMS (docs/harness.md §9). Frozen shapes, no logic.

The three things the platform plugs into meet here: the scope-file format, the
event schema, and the run/state shapes. Two languages (Python harness, TS
control plane) agree on these, so they are defined once, kept frozen, and never
carry behaviour. Every other slice imports from here; nothing here imports a
slice. This one-way dependency is what stops slices reaching into each other.
"""
