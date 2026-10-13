# Agentic software-development workflows: research

**Date:** 2026-09-15  
**Scope:** Git worktrees and branch isolation, multi-agent coding, PR integration, CI matrices and scheduled maintenance, repository instruction files, and durable feedback loops.

This is a synthesis of first-party documentation, not a prevalence survey. “Common” below means a pattern recommended or implemented in the primary sources.

## Executive conclusion

The reliable pattern is a small production line:

```text
task brief → isolated worker → focused verification → pull request
          → deterministic CI/review → protected integration branch
          → scheduled maintenance and encoded learnings
```

The important boundary is between *parallel exploration* and *parallel mutation*. Several agents can investigate, review, test, or propose changes at once. Agents that edit need separate worktrees and branches, explicit file ownership, and a single integration path. The primary sources consistently warn that shared-file editing and uncontrolled coordination erase the benefit of parallelism.

## Findings from primary sources

### 1. Isolation: one worktree per write-capable task

Git’s native `worktree` feature gives one repository multiple working directories and allows different branches to be checked out simultaneously. The worktrees share repository history but have per-worktree `HEAD` and index state; Git also provides `list`, `remove`, `prune`, `lock`, and `repair` operations. A new worktree can be created on a new branch or as a detached, throwaway checkout. [Git `worktree` documentation](https://git-scm.com/docs/git-worktree)

Anthropic’s first-party workflow documentation applies the same model to coding agents: each session gets its own files and branch, and `--worktree` creates a separate checkout. It also supports `isolation: worktree` for custom subagents, configurable base selection (`fresh` from the default branch or `head` from current in-progress work), and cleanup of agent-created worktrees. [Claude Code worktrees](https://code.claude.com/docs/en/worktrees)

**Implication:** never solve “I need several agents on this branch” by letting them write into one checkout. Keep the human’s active checkout, the integration checkout, and every agent checkout distinct. Use a read-only agent when no branch is needed.

### 2. Multi-agent work: coordinator, specialists, and bounded deliverables

Anthropic documents two useful levels:

- **Subagents:** focused workers with their own context that return a result to the caller. They are suitable when only the answer matters or when exploration would flood the main context.
- **Agent teams:** independent sessions coordinated by a lead, with a shared task list and direct messaging. They are suited to parallel research/review, separate modules, competing debugging hypotheses, and cross-layer work.

The same documentation says teams cost more tokens and coordination, work best when tasks are independent, and should not be used for sequential work or same-file edits. It recommends starting with research and review, making tasks self-contained, assigning different file sets, monitoring progress, and synthesising results in the lead. [Claude Code subagents and teams](https://code.claude.com/docs/en/sub-agents) · [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)

OpenAI’s current model guidance makes the same orchestration point explicit: instruct the model when parallel delegation is valuable, and calibrate verification to the risk and size of the change rather than running an indiscriminate full suite for every tiny edit. [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)

**Practical task contract for every worker:** base commit, objective, files it owns, files it must not touch, acceptance command, expected artifact, and stop/report conditions. A useful task produces a commit, review report, test result, or clearly named proposal—not an unbounded “improve the repository”.

### 3. PRs and integration: make the default branch the queue

GitHub protected branches can require pull requests, reviews, status checks, conversation resolution, linear history, signed commits, deployments, and code-owner approval. [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) A repository can also allow auto-merge so a PR merges once its requirements are met. [GitHub auto-merge](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository)

For a busy branch, GitHub’s merge queue groups PR changes with the latest base branch and earlier queued changes, runs the required checks against that combined state, and merges only if the group passes. A queue requires CI to listen to the separate `merge_group` event; `pull_request` checks alone are not sufficient. [GitHub merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) · [`merge_group` checks](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group)

**Implication:** protect `main` and let PRs be the integration queue. Use ordinary required checks first. Add a merge queue when concurrent PRs make “update branch, rerun CI, merge” a measurable bottleneck; it is unnecessary ceremony for a low-volume solo branch.

### 4. CI: parallelise independent checks, serialize only shared resources

GitHub Actions matrices turn one job definition into multiple combinations, run in parallel subject to runner availability, and support `fail-fast`, `continue-on-error`, and `max-parallel`. [Workflow matrix syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategy)

Actions also supports workflow/job concurrency groups. A PR group can cancel obsolete runs; a deployment or other shared resource can queue runs instead. [Actions concurrency](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)

Reusable workflows centralise deterministic, repeatable logic. GitHub explicitly positions them alongside agentic workflows: keep fixed build/test/deploy rules deterministic, and use an agent for contextual analysis, summaries, and recommendations. [Reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)

**Recommended CI shape:** separate Python, UI, model/IFC, and render-smoke jobs; run independent jobs concurrently; use a small version matrix where compatibility matters; upload logs and renders as artifacts; keep required check names stable; and cancel superseded PR runs without cancelling the integration branch’s final check.

### 5. Schedules: move durable automation out of an interactive session

GitHub workflows can run on repository events, manually, or on a cron schedule. Scheduled workflows run against the latest commit on the default branch; GitHub supports IANA time zones, though the default is UTC. [Workflow events and schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

Dependabot provides a low-risk baseline for continual maintenance: version updates and security updates are raised as pull requests, including updates to GitHub Actions themselves. [Dependabot version updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates)

Interactive agent schedulers are useful for polling a live task, but they are not the same as repository automation. Claude Code documents that session loops are session-scoped and expire, while durable work should use a cloud routine, desktop task, or GitHub Actions. [Claude Code scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)

### 6. Instructions and memory: global defaults, repository rules, path-scoped detail

OpenAI documents a layered `AGENTS.md` model: a global file under `~/.codex` is loaded first, then one instruction file per directory from the project root to the current directory. Later, more-specific files are appended later and therefore take precedence; Codex also provides a size limit and fallback filename configuration. [OpenAI `AGENTS.md` guide](https://developers.openai.com/codex/guides/agents-md/)

Anthropic documents the equivalent split for Claude Code: project `CLAUDE.md` for shared rules, user-level instructions for personal defaults, path-scoped `.claude/rules/` for local detail, and user/project `.claude/agents/` for reusable specialist definitions. Claude Code can import `AGENTS.md` from `CLAUDE.md`, avoiding duplicated project rules. [Claude Code memory](https://code.claude.com/docs/en/memory) · [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)

The boundary matters: instruction and auto-memory files are context, not hard enforcement. Anthropic recommends hooks for rules that must hold regardless of model choice. CI, protected branches, permissions, and transactional application code should enforce invariants. Auto-memory is best for preferences, corrections, and context that cannot be derived from the repository; shared project facts belong in version control.

### 7. Durable improvement: turn feedback into executable or reviewable artifacts

The durable loop is:

```text
failure/correction → classify → encode → verify → review/merge → observe again
```

Use the narrowest durable mechanism:

| Signal | Durable home |
|---|---|
| Reproducible bug or regression | Regression test |
| Repeated agent mistake or repository invariant | `AGENTS.md` / path-scoped rule |
| Repeatable multi-step operation | Script, CLI, skill, or reusable workflow |
| Architectural/design choice | Decision record or focused domain document |
| Safety or data-integrity boundary | Hook, CI check, protected branch, or application validation |
| Personal preference | Global user instructions or private memory |

GitHub Agentic Workflows extend this loop with scheduled or event-driven agents that can triage issues, investigate CI failures, review test coverage, update documentation, and produce issues, comments, or PRs. They are currently public preview. GitHub describes read-only defaults, declared safe outputs, isolated execution, and human control over review and merge. [About GitHub Agentic Workflows](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows) Use them after deterministic CI and permissions are sound, not as a replacement for either.

## Recommendations for Home Twin

### Current baseline observed on 2026-09-15

- The repository has a substantial root [`AGENTS.md`](../AGENTS.md), including IFC integrity, coordinate-frame, lighting-claim, testing, and worktree rules.
- The main checkout is on a feature branch with uncommitted work; two linked T3 worktrees already exist.
- There is no `.github/workflows/` directory yet.
- Python supports `>=3.11,<3.15`; the project has `pytest` and `ruff` development commands. The UI has separate `test` and `build` scripts.

This means the immediate bottleneck is not the ability to create more branches. It is the absence of a durable integration/verification lane and a global launcher that makes the safe lane cheap.

### Target operating model

1. **Global layer:** keep personal, cross-repository defaults in `~/.codex/AGENTS.md`: concise update style, default verification behaviour, worktree naming, no bare stash, and the standard task contract. If Claude Code is also used, keep reusable roles in `~/.claude/agents/` and make a project `CLAUDE.md` import the repository’s `AGENTS.md` rather than copying it.
2. **Repository layer:** keep Home Twin’s source-of-truth and design constraints in the checked-in `AGENTS.md`. Add path-scoped guidance only where it reduces context or prevents a local class of mistake. Keep canonical IFC and reviewed plan-source mutations single-writer; let other agents analyse or prepare proposals in isolation.
3. **Work layer:** use a stable integration checkout plus one worktree/branch per write-capable task. Name branches by intent, for example `agent/ui-ceiling`, `agent/ifc-validation`, and `agent/docs-lighting`. Give each agent explicit file ownership. Run separate UI/server ports and keep generated exports out of the merge path unless they are intentional artifacts.
4. **Coordinator layer:** use a short-lived task ledger—issue, Markdown brief, or PR description—with base SHA, owner, files, acceptance command, and result. The coordinator integrates commits one at a time, reruns the relevant checks, and is the only lane allowed to update the shared integration branch.
5. **Integration layer:** protect `main` with required PR review and required CI. Enable auto-merge for low-risk PRs only after checks are green. Defer a merge queue until PR concurrency justifies it; if enabled, add `merge_group` to every workflow that reports a required check.

### First CI set to add later

Create a small set of deterministic workflows, preferably through reusable jobs rather than duplicated YAML:

- Python quality: `uv run --extra dev pytest` and `uv run --extra dev ruff check .`, with a Python 3.11–3.14 compatibility matrix or a deliberately smaller supported-version policy.
- UI quality: `bun --cwd ui vitest run` and `bun --cwd ui run build`.
- Model integrity: synthetic IFC save/reload, plan-source round-trip, geometry/containment/collision checks, and canonical-file protection checks.
- Review artifacts: targeted render smoke tests and logs on relevant paths; do not make every edit pay for an expensive full render unless the changed files require it.
- Triggers: `pull_request`, pushes to `main`, manual dispatch, and `merge_group` if a merge queue is enabled.
- Concurrency: cancel stale PR runs; do not cancel a run that is the current integration proof.

### Continual-improvement jobs

After CI is reliable, schedule:

- nightly or weekly full validation and render smoke checks;
- weekly Dependabot updates for Python, UI packages, and GitHub Actions;
- a read-only weekly agent review for stale worktrees, failing checks, documentation drift, repeated test failures, and untested high-risk paths;
- an agent-generated issue or PR containing evidence and a proposed minimal change, with human review before merge.

The improvement agent should never silently rewrite `model/house.ifc` or `model/references/plan.yaml`. For this repository, the safe output is an issue, report, test, or reviewed transactional change—not an autonomous mutation of the canonical model.

### What to measure

Track only a few signals: time from task dispatch to a passing check, first-run CI pass rate, PR time waiting for review, stale worktrees, merge-conflict rate, repeated corrections, and the number of maintenance findings that become tests or rules. If a new agent or automation does not improve one of these, remove it.

## Source list

- [Git `worktree`](https://git-scm.com/docs/git-worktree)
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI `AGENTS.md` configuration](https://developers.openai.com/codex/guides/agents-md/)
- [Claude Code worktrees](https://code.claude.com/docs/en/worktrees)
- [Claude Code subagents and agent teams](https://code.claude.com/docs/en/sub-agents) · [agent teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code memory](https://code.claude.com/docs/en/memory) · [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) · [merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) · [reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
- [GitHub schedules and events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) · [Dependabot version updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates)
- [GitHub Agentic Workflows](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows)
