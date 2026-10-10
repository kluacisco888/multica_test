# Issue tracker: Multica

Issues, specs and tickets for this repo live in the Multica workspace that runs the agents, in the project **复刻滴答清单**. They do not live in GitHub Issues: never use `gh issue`. Use the `multica` CLI for every operation; it is already authenticated inside agent runs.

Get the project id with `multica project list --output json` (the project whose title is `复刻滴答清单`).

## Conventions

- **Create an issue**: write the body to a file, then `multica issue create --title "..." --description-file <file> --project <project-id> --status backlog`. Leave the assignee empty unless a skill or the user says otherwise: assigning an issue starts an agent run.
- **Read an issue**: `multica issue get <id>` returns the description as JSON; read comments with `multica issue comment list <id>`. Ids look like `ABC-12` or a UUID.
- **List / search issues**: `multica issue list --project <project-id> --output json`, or `multica issue search "<text>"`.
- **Make an issue a sub-issue of a parent**: create it with `--parent <parent-id>`, or `multica issue update <child-id> --parent <parent-id>` afterwards. List children with `multica issue children <parent-id>`.
- **Comment on an issue**: write the body to a file, then `multica issue comment add <id> --content-file <file>`.
- **Apply / remove labels**: find label ids with `multica label list --output json`, then `multica issue label add <issue-id> <label-id>` / `multica issue label remove <issue-id> <label-id>`.
- **Change status**: `multica issue status <id> <status>`, one of `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`. Add `--no-start` when the change is bookkeeping only and must not start an agent run.
- **Close**: comment first with the reason, then set `done` (completed) or `cancelled` (won't do).

## When a skill says "publish to the issue tracker"

Create a Multica issue in the project above, status `backlog`, no assignee. Reply with the issue id and link.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above, including its comments, and for a sub-issue also read its parent (the spec).

## Blocking edges

Multica has no native "blocked by" link. Express every edge in both of these ways:

- **Stage**: create each ticket as a sub-issue of the spec with `--stage N`. N is `1` for a ticket with no blockers, otherwise `1 +` the highest stage among its blockers. Multica wakes the parent's assignee only when every sub-issue in the earliest open stage is `done` or `cancelled`; that is how the next stage gets started.
- **Text**: keep the `## Blocked by` section in the ticket body, listing blocker ids, or "None (can start immediately)".

A ticket is unblocked when every listed blocker is `done`.

## Who starts the work

Specs and tickets are created unassigned in `backlog`. The human reviews them and assigns the parent spec to the squad **软件交付小队**. The squad leader then assigns each stage's tickets to the squad, and each ticket runs implement → review on its own.

## Pull requests as a triage surface

**PRs as a request surface: no.**
