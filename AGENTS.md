# AGENTS.md

## Agent skills

### Issue tracker

Issues, specs and tickets live in Multica (project 复刻滴答清单) and are managed with the `multica` CLI, not GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Image budget

Opening images bloats the session and makes requests time out (the error looks like "model temporarily unavailable"). Read `docs/agents/image-budget.md` before taking or viewing any screenshot.
