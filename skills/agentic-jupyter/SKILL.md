---
name: agentic-jupyter
description: Use this skill when you need to operate a reachable local or remote Jupyter server, or a VS Code Jupyter notebook host, through the `agentic-jupyter` MCP server or CLI, including notebook and cell editing, Jupyter file I/O, code execution, streaming output, kernel-backed shell commands, and manual SSH port-forward workflows.
---

# Agentic Jupyter

Use this skill when the task is about controlling Jupyter from Codex or from the terminal, including a VS Code notebook bridged through the local host extension.

## When to use MCP vs CLI

- Use MCP when the user wants Codex to call tools directly from the current session.
- Use CLI when the user wants shell commands, scripting, profile-based reuse, or to run the workflow outside MCP.
- If the remote Jupyter is not directly reachable, create the SSH port forward outside `agentic-jupyter` first and then connect to the forwarded local endpoint.

## Standard workflows

### 1. Connect to remote Jupyter

- MCP:
  - Call `connect_remote_jupyter`.
  - Prefer `jupyter_base_url` when you already know the full endpoint.
  - Otherwise use `jupyter_host` and `jupyter_port`.
- CLI:
  - Save a reusable profile:
    - `agentic-jupyter profile set local --jupyter-host 127.0.0.1 --jupyter-port 8888 --jupyter-token ...`
  - Validate a connection:
    - `agentic-jupyter connect-remote-jupyter --profile local`

### 2. Connect to a VS Code notebook host

- VS Code:
  - Open the notebook in VS Code.
  - Select a kernel first.
  - Run `Agentic Jupyter: Start Host`.
  - Run `Agentic Jupyter: Copy Connection Info`.
- CLI:
  - Save a reusable profile:
    - `agentic-jupyter profile set editor --backend vscode-host --vscode-host 127.0.0.1 --vscode-port 8765 --vscode-token ...`
  - Validate the connection:
    - `agentic-jupyter get-connection-status --profile editor --json`
- Defaults:
  - VS Code mode uses the active notebook when `--path` is omitted.
  - The copied token is ephemeral. Update the profile after restarting the VS Code host.

### 3. Inspect notebooks and files

- MCP:
  - `list_jupyter_contents`
  - `get_notebook`
  - `list_cells`
  - `read_jupyter_file`
- CLI:
  - `agentic-jupyter list-jupyter-contents --profile <name>`
  - `agentic-jupyter get-notebook --profile <name> --path notebook.ipynb`
  - `agentic-jupyter list-cells --profile <name> --path notebook.ipynb`
  - In VS Code mode, prefer `agentic-jupyter list-cells --profile <name>` with no `--path` unless a non-active open notebook is required.

### 4. Edit notebooks and cells

- MCP:
  - `create_notebook`, `insert_cell`, `update_cell`, `delete_cell`, `move_cell`
- CLI:
  - Use the matching kebab-case commands.
  - Prefer `--source-file` for multiline cell content.
  - Use `--metadata-json` when metadata must be preserved explicitly.

### 5. Execute code and commands

- MCP:
  - `execute_code`, `run_cell`, `run_cells`
  - `run_command` for shell commands executed through a Python notebook kernel
- CLI:
  - Use the matching commands.
  - Prefer `--code-file` for multiline code.
  - Use `--json` when the output needs to be consumed by another tool or script.
  - Use `--stream` for line-by-line `stdout` and `stderr`.
  - In VS Code mode, prefer `--stream` because completion is more reliable than the non-stream path.

### 6. Stream output

- `--stream` is supported on:
  - `run-cell`
  - `run-cells`
  - `execute-code`
  - `run-command`
- `--stream --json` emits NDJSON events one per line.
- Important events:
  - `run_start`
  - `cell_start`
  - `cell_skipped`
  - `stdout`
  - `stderr`
  - `cell_complete`
  - `run_complete`
  - `exec_complete`
  - `command_complete`
- Example:
  - `agentic-jupyter run-cell --profile editor --index 0 --stream --json`
  - `agentic-jupyter run-cells --profile editor --start-index 0 --end-index 3 --stream`

### 7. Transfer and edit files through Jupyter

- MCP:
  - `read_jupyter_file`, `write_jupyter_file`, `upload_file`, `download_file`
- CLI:
  - Use the matching commands.
  - `upload_file` and `download_file` move files between the local machine and the Jupyter workspace through the Contents API.

## Operational considerations

- `execute_code` runs against the notebook's kernel only. It does not create a cell and does not write outputs back into the notebook file.
- If the result must remain in the notebook, first create or update a code cell, then use `run_cell` or `run_cells`.
- `run_command` depends on the notebook kernel. Use it only when the notebook is attached to a Python kernel.
- In VS Code mode, `run_cell --stream` and `run_cells --stream` are the safest execution paths.
- Do not run notebook mutation commands in parallel against the same notebook path.
- Treat `insert_cell`, `update_cell`, `delete_cell`, `move_cell`, `run_cell`, `run_cells`, and follow-up reads like `get_notebook` as a sequential workflow on one notebook.
- If you see unreadable notebook errors or stale contents, retry the notebook workflow sequentially instead of overlapping edits, runs, and reads.

## Profiles

- Profiles live in `~/.config/agentic-jupyter/profiles.json` unless `XDG_CONFIG_HOME` is set.
- Profiles store either remote Jupyter settings or VS Code host settings, plus optional `default_notebook_path`.
- Explicit CLI flags override profile values.

## Practical defaults

- Prefer a named profile before repeated CLI work.
- Prefer `jupyter_base_url` when the endpoint is already known or forwarded locally.
- Prefer `--json` for scripting and default human-readable output for inspection.
- Prefer `--stream --json` when validating a VS Code or Colab notebook bridge.
