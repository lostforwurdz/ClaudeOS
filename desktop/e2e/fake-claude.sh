#!/usr/bin/env bash
# Fake `claude` binary for E2E preflight (kobramaz-ajr.5).
# The MVP E2E suite never actually invokes a Claude run — workspace
# CRUD does not require a real CLI. Preflight only checks the binary
# exists on PATH (via `which`), so a no-op script is enough to satisfy
# the gate without burning an OAuth token in CI.
exit 0
