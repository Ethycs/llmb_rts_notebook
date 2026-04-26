# Pixi CLI Quick Reference

Pixi is a fast, cross-platform package manager built on the conda ecosystem. It manages project dependencies via a `pixi.toml` (or `pyproject.toml`) manifest and a `pixi.lock` lockfile.

## Core Concepts

- **Workspace**: A directory with a `pixi.toml` or `pyproject.toml` manifest.
- **Environment**: A resolved set of dependencies (conda and/or PyPI). A workspace can have multiple environments.
- **Task**: A named command defined in the manifest, runnable via `pixi run`.
- **Lock file**: `pixi.lock` pins exact dependency versions. Auto-generated/updated.
- **Channel**: A conda package repository (e.g. `conda-forge`).

## Installation

```bash
curl -fsSL https://pixi.sh/install.sh | bash
```

## Workspace Lifecycle

### Create a workspace

```bash
pixi init                              # in current dir
pixi init myproject                    # in new dir
pixi init --format pyproject           # use pyproject.toml instead of pixi.toml
pixi init -c conda-forge -c bioconda   # specify channels
pixi init -p linux-64 -p osx-arm64     # specify platforms
pixi init --import environment.yml     # import from conda env file
```

### Install environment (solve + install)

```bash
pixi install                           # install default environment
pixi install -e myenv                  # install a specific environment
```

### Lock only (solve without installing)

```bash
pixi lock
```

## Dependency Management

### Add dependencies

```bash
pixi add numpy                         # conda package
pixi add "numpy>=1.24"                 # with version constraint
pixi add numpy pandas scipy            # multiple at once
pixi add --pypi requests               # PyPI package
pixi add --pypi "requests>=2.28"       # PyPI with constraint
pixi add --pypi -e ./mypackage         # editable local PyPI package
pixi add -p linux-64 cuda-toolkit      # platform-specific
pixi add -f cuda cuda-toolkit          # feature-specific
```

### Remove dependencies

```bash
pixi remove numpy
pixi remove --pypi requests
```

### List installed packages

```bash
pixi list                              # all packages in default env
pixi list -e myenv                     # specific environment
```

### Search for packages

```bash
pixi search numpy
```

### Update dependencies

```bash
pixi update                            # update all deps (respecting constraints)
pixi update numpy                      # update specific package
```

### Upgrade dependencies (also updates manifest constraints)

```bash
pixi upgrade                           # upgrade all
pixi upgrade numpy                     # upgrade specific
```

## Tasks

### Define tasks (via CLI)

```bash
pixi task add test "pytest tests/"
pixi task add lint "ruff check ."
pixi task add build "python -m build"
pixi task add serve "python -m http.server"
```

### Task with dependencies

In `pixi.toml`:
```toml
[tasks]
build = "python -m build"
test = { cmd = "pytest", depends-on = ["build"] }
```

### Run tasks

```bash
pixi run test                          # run a defined task
pixi run python script.py             # run any command in the environment
pixi run -e myenv test                 # run in specific environment
pixi run --clean-env test              # run with clean environment (no host env leakage)
```

### List tasks

```bash
pixi task list
```

### Remove tasks

```bash
pixi task remove test
```

## Shell Access

```bash
pixi shell                             # start a shell with the environment activated
pixi shell -e myenv                    # specific environment
# run `exit` to leave
```

### Shell hook (for script integration)

```bash
eval "$(pixi shell-hook)"             # activate env in current shell
```

## One-off Execution (No Workspace Needed)

```bash
pixi exec python                       # run python from a temp environment
pixi exec -c conda-forge bat README.md # run any tool from any channel
```

## Global Tool Installation

Install tools globally (available system-wide, like `pipx`):

```bash
pixi global install ruff
pixi global install bat ripgrep fd-find
pixi global remove ruff
pixi global list
```

## Inspection

```bash
pixi info                              # system, workspace, and environment info
pixi tree                              # dependency tree
pixi list                              # installed packages
```

## Cleaning Up

```bash
pixi clean                             # remove installed environments
```

## Manifest Format (`pixi.toml` example)

```toml
[project]
name = "myproject"
channels = ["conda-forge"]
platforms = ["linux-64", "osx-arm64"]

[dependencies]
python = ">=3.11"
numpy = ">=1.24"

[pypi-dependencies]
requests = ">=2.28"

[tasks]
test = "pytest tests/"
serve = "python -m http.server 8000"

[feature.cuda]
platforms = ["linux-64"]

[feature.cuda.dependencies]
cuda-toolkit = ">=12.0"

[environments]
default = { features = [] }
cuda = { features = ["cuda"] }
```

## Key Files

| File | Purpose |
|---|---|
| `pixi.toml` | Project manifest (deps, tasks, envs) |
| `pyproject.toml` | Alternative manifest (Python projects) |
| `pixi.lock` | Lockfile (commit to VCS) |
| `.pixi/` | Local environment cache (gitignore this) |

## Global Options (all commands)

| Flag | Effect |
|---|---|
| `-v` / `-vv` / `-vvv` | Increase verbosity |
| `-q` | Quiet mode |
| `--no-progress` | Hide progress bars |
| `--manifest-path <PATH>` | Point to a specific manifest |
| `--color always\|never\|auto` | Control colored output |

## Common Workflows

**Start a Python project:**
```bash
pixi init myproject && cd myproject
pixi add python "numpy>=1.24" pandas
pixi add --pypi matplotlib
pixi task add start "python main.py"
pixi run start
```

**Add to existing project (pyproject.toml):**
```bash
pixi init --format pyproject
pixi add python
pixi add --pypi -e .
```

**CI usage:**
```bash
pixi install --locked    # fail if lockfile is outdated
pixi run test
```