// tests/setup.ts — preloaded by bunfig.toml's [test].preload before any
// test file is imported. Sets fake values for the three env vars
// server.ts requires at top-level (MOLECULE_PLATFORM_URL,
// MOLECULE_WORKSPACE_IDS, MOLECULE_WORKSPACE_TOKENS). Without this,
// importing server.ts (which the test files do, to pull
// formatRemovedWorkspaceError + other pure helpers) hits the
// required-config guard at server.ts:92 and calls process.exit(1) —
// killing the test runner before any test runs.
//
// `??=` only assigns when the var is unset, so a developer running
// `bun test` locally with a populated .env file isn't overridden.

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

process.env.MOLECULE_PLATFORM_URL ??= 'http://localhost:18080'
process.env.MOLECULE_WORKSPACE_IDS ??= 'ws-test-00000000-0000-0000-0000-000000000001'
process.env.MOLECULE_WORKSPACE_TOKENS ??= 'tok-test'

// Force state dir into a temp directory so tests never compete for or modify
// production primary-election and cursor state under
// ~/.claude/channels/molecule/. Without this, importing server.ts (which
// mkdirSync's STATE_DIR and participates in primary election) could claim the
// lock or create a secondary cursor beside a live watcher. See issue #14.
process.env.MOLECULE_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'mcp-claude-channel-test-'))
