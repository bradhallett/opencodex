# 030 — wp3: live Desktop proof and PR

## Live proof

The user's service runs from the main checkout; this worktree's code is proven without restarting
or reconfiguring it. A scratch server starts from this worktree through `startServer` directly
(the same entry the integration tests use, so no CLI ensure/sync step touches `~/.codex` or the
service manager), with `OPENCODEX_HOME` pointing at a scratch directory outside the repository.
Its config holds only one provider that authenticates with a static API key (`zai` or `aim`,
copied from the user's config; OAuth providers are excluded because a refresh in the copy could
rotate the user's token), `claudeCode.intercept.port` 10400 and public port 10300. The scratch
server mints its own intercept CA. The scratch config carries no `openai`/Codex provider, so the
Codex sync and quota paths stay inert (src/server/index.ts:276-287, src/codex/quota-auto-refresh.ts:279),
and the service-ownership check reads the default-home records and fails closed to "foreign"
(src/service/state.ts:156-157). The repointed `NODE_EXTRA_CA_CERTS` reads as foreign to the user's
own proxy, so its ensure step does not rewrite it mid-probe (src/claude/intercept/settings.ts:88-99).

1. Back up `~/.claude/settings.json` (already at `/tmp/ocx-claude-probe/backup/`), then point
   `HTTPS_PROXY` at 10400 and `NODE_EXTRA_CA_CERTS` at the scratch CA for the probe.
2. `ocx claude desktop bind claude-sonnet-4-6 <provider>/<model>` against the scratch server
   (CLI targets it through the scratch home), and the dashboard card for the GUI screenshot.
3. Fully quit and reopen Claude Desktop (first-party), Code tab, pick Sonnet 4.6, send a probe;
   pick Haiku 4.5 and send a second probe.
4. Evidence: scratch `usage.jsonl` shows the bound provider for the Sonnet 4.6 probe and
   `anthropic-native` for Haiku 4.5; the user's own proxy log shows no new Messages rows for the
   probes; screenshots of the Desktop conversation, the picker and the dashboard card, cropped to
   exclude account names.
5. Restore: settings.json byte-for-byte from backup, stop the scratch server, delete the scratch
   home, fully quit and reopen Desktop, confirm the user's proxy on 10100/10200 is untouched.

## PR

- Branch `codex/claude-desktop-first-party-models` → `dev`, repository template (Summary,
  Verification, Checklist), screenshots uploaded to the `pr-assets` branch and linked by commit SHA.
- Report exact-head CI; do not merge.
