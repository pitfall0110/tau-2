# tau

`tau` is a small CLI for running a staged SWE workflow:

1. `generate` mines a commit and creates a task.
2. `solve` runs a solver against that task.
3. `compare` scores two saved solutions by changed-line similarity.
4. `eval` compares multiple solutions with an LLM judge.
5. `delete` removes saved task artifacts.

## Modify And Share The Main Agent

The default agent used by this repo lives in `tau/agent`.

If you want to change the main agent behavior, edit that workspace directly. `tau solve` accepts `--agent ./agent`, so your local changes are picked up automatically:

```bash
source .venv/bin/activate
tau solve --task my-task --solution local-dev --agent ./agent
```

If you want other people or other machines to use the same agent, put it in a GitHub repo and keep the agent workspace at either:

- the repo root, if that root already contains `packages/coding-agent`
- `agent/`, if the repo is a larger project and the agent lives in a nested `agent` directory

Then you can share it via GitHub and run it with either a full GitHub URL or the `owner/repo` shorthand:

```bash
source .venv/bin/activate
tau solve --task my-task --solution shared --agent owner/repo
```

or:

```bash
source .venv/bin/activate
tau solve --task my-task --solution shared --agent https://github.com/owner/repo
```

This makes it easy to iterate locally in `tau/agent`, then publish the same agent for reproducible runs elsewhere.

## Prerequisites

- Python 3.11+
- `uv`
- Docker
- A GitHub token for task generation
- An OpenRouter API key for Docker PI solves and evaluation
- A Cursor API key for Cursor solves

## Setup

From the `tau/` directory:

```bash
source .venv/bin/activate
uv pip install -e .
```

Create a `.env` file in `tau/` if you do not already have one:

```bash
GITHUB_TOKEN=your_github_token
OPENROUTER_API_KEY=your_openrouter_api_key
CURSOR_API_KEY=your_cursor_api_key
```

`tau` loads `.env` automatically from the project root.

## Basic Usage

Show top-level help:

```bash
source .venv/bin/activate
tau --help
```

All commands write their artifacts under:

```text
workspace/tasks/
```

You can override that with `--workspace-root /path/to/root`.

## Generate A Task

```bash
source .venv/bin/activate
tau generate --task my-task
```

Useful options:

- `--generator-model <model>`
- `--seed <int>`
- `--max-mining-attempts <int>`
- `--agent-timeout <seconds>`
- `--debug`

## Solve A Task

`solve` supports multiple backends. The `--agent` value can be:

- `cursor` to run the Cursor CLI in Docker
- `claude` to run the local Claude CLI on the host
- a local agent workspace directory for the Docker PI solver
- a repo root that contains `agent/` for the Docker PI solver
- a GitHub repo URL or shorthand like `owner/repo` for the Docker PI solver

Example using Cursor:

```bash
source .venv/bin/activate
tau solve --task my-task --solution cursor-run --agent cursor
```

Example using Claude:

```bash
source .venv/bin/activate
tau solve --task my-task --solution claude-run --agent claude
```

Example using the local bundled agent checkout in this repo:

```bash
source .venv/bin/activate
tau solve --task my-task --solution baseline --agent ./agent
```

Example using a GitHub repo:

```bash
source .venv/bin/activate
tau solve --task my-task --solution baseline --agent badlogic/pi-mono
```

Useful options:

- `--solver-model <model>`
- `--solver-max-requests <int>`
- `--solver-max-total-tokens <int>`
- `--solver-max-cost <float>`
- `--docker-solver-memory 2g`
- `--docker-solver-cpus 2`
- `--docker-solver-no-cache`
- `--agent-timeout <seconds>`
- `--debug`

## Compare Solutions

Compare two saved solutions using changed-lines-only similarity:

```bash
source .venv/bin/activate
tau compare --task my-task --solutions cursor-run baseline
```

Comma-separated values also work:

```bash
source .venv/bin/activate
tau compare --task my-task --solutions cursor-run,baseline
```

## Evaluate Solutions

Compare two or more solutions for the same task:

```bash
source .venv/bin/activate
tau eval --task my-task --solutions baseline candidate-a candidate-b
```

Comma-separated values also work:

```bash
source .venv/bin/activate
tau eval --task my-task --solutions baseline,candidate-a,candidate-b
```

Useful options:

- `--eval-model <model>`
- `--seed <int>`
- `--agent-timeout <seconds>`
- `--debug`

## Delete Saved Artifacts

Delete one task:

```bash
source .venv/bin/activate
tau delete --task my-task
```

Delete all saved tasks:

```bash
source .venv/bin/activate
tau delete task --all
```

## End-To-End Example

```bash
source .venv/bin/activate
tau generate --task demo-task
tau solve --task demo-task --solution run-1 --agent cursor
tau solve --task demo-task --solution run-2 --agent ./agent
tau compare --task demo-task --solutions run-1 run-2
tau eval --task demo-task --solutions run-1 run-2
```

## Cursor Agent In Docker

When you pass `--agent cursor`, tau builds a Docker image, runs the Cursor CLI inside it, and collects the resulting diff.

### What happens

1. A Docker image (`swe-eval/cursor-solver:<hash>`) is built from `python:3.11-slim` with the Cursor CLI installed via `curl https://cursor.com/install | bash`.
2. A container starts with resource limits (memory, CPU, pids, tmpfs).
3. The task repo is copied into the container at `/work/repo` and the prompt is written to `/work/task.txt`.
4. The Cursor `agent` CLI runs inside the container with `CURSOR_API_KEY` injected:

```bash
agent -p --force --trust --sandbox disabled --output-format stream-json \
    --workspace /work/repo "$PROMPT"
```

5. The diff is collected from the container and applied back to the host repo.
6. The container is torn down.

### Usage

```bash
source .venv/bin/activate
tau solve --task my-task --solution cursor-run --agent cursor
```

`CURSOR_API_KEY` must be set in your environment or in `tau/.env`.

### Docker options

| Flag | Purpose |
|------|---------|
| `--solver-model <model>` | Override the model used by Cursor |
| `--agent-timeout <seconds>` | Time limit for the solve |
| `--docker-solver-memory 2g` | Container memory limit |
| `--docker-solver-cpus 2` | Container CPU limit |
| `--docker-solver-no-cache` | Force rebuild the Docker image |
| `--debug` | Enable debug logging |

## Notes

- `generate` needs `GITHUB_TOKEN` or `GH_TOKEN`.
- `tau solve --agent cursor` needs `CURSOR_API_KEY` and Docker.
- `tau solve --agent claude` needs the `claude` CLI installed on the host.
- Docker PI solves and `eval` need `OPENROUTER_API_KEY`.
- `compare` reads saved solution artifacts and does not call a model.
- Docker-backed solves use Docker, so Docker must be installed and running.
- Generated task, solution, and evaluation paths are printed by the CLI after each command finishes.
