# agentic-jupyter

`agentic-jupyter` is now a 2-workspace monorepo:

- `packages/cli`: the CLI package, internal libraries, and MCP server
- `packages/vscode`: the VS Code host bridge extension

## Workspace Layout

- `packages/cli`
- `packages/vscode`

## Requirements

- Node.js 20+
- Bun 1.3+ for the Bun-based test suite
- For remote Jupyter mode: a reachable Jupyter Server and token if required
- For VS Code host mode: Desktop VS Code with the Jupyter extension installed

## Install

```bash
npm install
```

## Run

Start the MCP server:

```bash
npm run serve
# or
npm run build
cd packages/cli && npm run serve
```

Run validation:

```bash
npm run check
bun run test
npm run build
```

## CLI Backends

Remote Jupyter profile:

```bash
agentic-jupyter profile set remote \
  --backend remote-jupyter \
  --jupyter-host 127.0.0.1 \
  --jupyter-port 8888 \
  --jupyter-token YOUR_TOKEN \
  --default-notebook-path demo.ipynb
```

VS Code host profile:

```bash
agentic-jupyter profile set editor \
  --backend vscode-host \
  --vscode-host 127.0.0.1 \
  --vscode-port 8765 \
  --vscode-token YOUR_TOKEN
```

The VS Code extension provides:

- `Agentic Jupyter: Start Host`
- `Agentic Jupyter: Stop Host`
- `Agentic Jupyter: Copy Connection Info`

Once the host is started, copy the connection info JSON and feed its `host` / `port` / `token` into the CLI or MCP client.

## Commands

The CLI and MCP surface keep these verbs:

- `connect-remote-jupyter`
- `connect-vscode-host`
- `disconnect-remote-jupyter`
- `get-connection-status`
- `list-jupyter-contents`
- `read-jupyter-file`
- `write-jupyter-file`
- `create-notebook`
- `get-notebook`
- `list-cells`
- `insert-cell`
- `update-cell`
- `delete-cell`
- `move-cell`
- `execute-code`
- `run-cell`
- `run-cells`
- `run-command`
- `upload-file`
- `download-file`

In VS Code host mode, notebook actions accept `--path @active` implicitly when omitted.

## MCP Tools

- `connect_remote_jupyter`
- `connect_vscode_host`
- `disconnect_remote_jupyter`
- `get_connection_status`
- `list_jupyter_contents`
- `read_jupyter_file`
- `write_jupyter_file`
- `create_notebook`
- `get_notebook`
- `list_cells`
- `insert_cell`
- `update_cell`
- `delete_cell`
- `move_cell`
- `execute_code`
- `run_cell`
- `run_cells`
- `run_command`
- `upload_file`
- `download_file`
