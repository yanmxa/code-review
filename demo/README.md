# demo

A tiny service whose only purpose is to be reviewed.

The open pull request against this directory contains **deliberately planted
defects** — a committed credential, SQL built by concatenation, a
non-cryptographic token, a swallowed exception, an off-by-one retry loop, and a
cache eviction bug. It is what the screenshots in the README show, and what the
sample artifacts in `examples/` were generated from.

Nothing here is imported by the agent itself, and this directory is excluded
from `tsconfig.json`, so the planted defects never reach the build or CI.
