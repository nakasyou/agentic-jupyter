import { z } from 'zod/v4';
import { RemoteJupyterError } from './errors.js';
function defineAction(name, description, inputSchema) {
    return {
        name,
        cliName: name.replaceAll('_', '-'),
        description,
        inputSchema,
    };
}
export const connectRemoteJupyterInputSchema = z.object({
    jupyter_base_url: z.string().optional(),
    jupyter_host: z.string().optional(),
    jupyter_port: z.number().int().positive().default(8888),
    jupyter_protocol: z.enum(['http', 'https']).default('http'),
    jupyter_token: z.string().optional(),
    jupyter_base_path: z.string().default('/'),
});
export const connectVscodeHostInputSchema = z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive(),
    token: z.string(),
    secure: z.boolean().default(false),
});
const connectionIdInputSchema = z.object({
    connection_id: z.string(),
});
export const actionDefinitions = [
    defineAction('connect_remote_jupyter', 'Connect directly to a reachable Jupyter server endpoint.', connectRemoteJupyterInputSchema),
    defineAction('connect_vscode_host', 'Connect to the local VS Code host bridge over WebSocket.', connectVscodeHostInputSchema),
    defineAction('disconnect_remote_jupyter', 'Close a backend connection and clear cached notebook sessions.', connectionIdInputSchema),
    defineAction('get_connection_status', 'Inspect backend reachability and cached notebook sessions.', connectionIdInputSchema),
    defineAction('list_jupyter_contents', 'List files and directories through the active backend.', connectionIdInputSchema.extend({
        path: z.string().default(''),
    })),
    defineAction('read_jupyter_file', 'Read a file through the active backend.', connectionIdInputSchema.extend({
        path: z.string(),
        format: z.enum(['text', 'base64']).nullable().default(null),
    })),
    defineAction('write_jupyter_file', 'Write a file through the active backend.', connectionIdInputSchema.extend({
        path: z.string(),
        content: z.string(),
        format: z.enum(['text', 'base64']).default('text'),
        create_dirs: z.boolean().default(true),
    })),
    defineAction('create_notebook', 'Create a new notebook file in the active backend.', connectionIdInputSchema.extend({
        path: z.string(),
        kernel_name: z.string().default('python3'),
    })),
    defineAction('get_notebook', 'Fetch a notebook model including all cells and metadata.', connectionIdInputSchema.extend({
        path: z.string().optional(),
    })),
    defineAction('list_cells', 'List notebook cells with execution metadata and summarized outputs.', connectionIdInputSchema.extend({
        path: z.string().optional(),
    })),
    defineAction('insert_cell', 'Insert a cell into a notebook and save immediately.', connectionIdInputSchema.extend({
        path: z.string().optional(),
        index: z.number().int().min(0),
        cell_type: z.enum(['code', 'markdown', 'raw']),
        source: z.string(),
        metadata: z.record(z.string(), z.unknown()).default({}),
    })),
    defineAction('update_cell', 'Update a notebook cell and save immediately.', connectionIdInputSchema.extend({
        path: z.string().optional(),
        index: z.number().int().min(0),
        source: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        cell_type: z.enum(['code', 'markdown', 'raw']).optional(),
    })),
    defineAction('delete_cell', 'Delete a notebook cell and save immediately.', connectionIdInputSchema.extend({
        path: z.string().optional(),
        index: z.number().int().min(0),
    })),
    defineAction('move_cell', 'Move a notebook cell and save immediately.', connectionIdInputSchema.extend({
        path: z.string().optional(),
        from_index: z.number().int().min(0),
        to_index: z.number().int().min(0),
    })),
    defineAction('execute_code', "Execute code against the notebook's kernel without modifying the notebook file.", connectionIdInputSchema.extend({
        path: z.string().optional(),
        code: z.string(),
        timeout_sec: z.number().positive().default(120),
    })),
    defineAction('run_cell', 'Execute a single notebook cell, update outputs, and optionally save the notebook.', connectionIdInputSchema.extend({
        path: z.string().optional(),
        index: z.number().int().min(0),
        timeout_sec: z.number().positive().default(120),
        save: z.boolean().default(true),
    })),
    defineAction('run_cells', 'Execute a range of notebook cells, updating outputs and optionally stopping on the first error.', connectionIdInputSchema.extend({
        path: z.string().optional(),
        start_index: z.number().int().min(0).default(0),
        end_index: z.number().int().min(0).optional(),
        timeout_sec: z.number().positive().default(120),
        stop_on_error: z.boolean().default(true),
        save: z.boolean().default(true),
    })),
    defineAction('run_command', 'Execute a shell command via a Python notebook kernel.', connectionIdInputSchema.extend({
        path: z.string().optional(),
        command: z.string(),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        timeout_sec: z.number().positive().default(120),
    })),
    defineAction('upload_file', 'Upload a local file into the backend workspace.', connectionIdInputSchema.extend({
        local_path: z.string(),
        remote_path: z.string(),
        create_dirs: z.boolean().default(true),
    })),
    defineAction('download_file', 'Download a file from the backend workspace to the local machine.', connectionIdInputSchema.extend({
        remote_path: z.string(),
        local_path: z.string(),
        overwrite: z.boolean().default(false),
    })),
];
export const actionMap = new Map(actionDefinitions.map((action) => [action.name, action]));
export const cliActionMap = new Map(actionDefinitions.map((action) => [action.cliName, action]));
export function createRunCommandCode(command, cwd, env) {
    return `
import json
import os
import subprocess
import sys
import threading

stdout_chunks = []
stderr_chunks = []

process = subprocess.Popen(
    ${JSON.stringify(command)},
    shell=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
    cwd=${JSON.stringify(cwd ?? null)},
    env=dict(os.environ, **${JSON.stringify(env ?? {})}),
)

def forward_stream(pipe, writer, chunks):
    try:
        for line in iter(pipe.readline, ""):
            chunks.append(line)
            writer.write(line)
            writer.flush()
        remainder = pipe.read()
        if remainder:
            chunks.append(remainder)
            writer.write(remainder)
            writer.flush()
    finally:
        pipe.close()

stdout_thread = threading.Thread(target=forward_stream, args=(process.stdout, sys.stdout, stdout_chunks))
stderr_thread = threading.Thread(target=forward_stream, args=(process.stderr, sys.stderr, stderr_chunks))
stdout_thread.start()
stderr_thread.start()
process.wait()
stdout_thread.join()
stderr_thread.join()

print("__REMOTE_JUPYTER_MCP_RUN_COMMAND__" + json.dumps({
    "exit_code": process.returncode,
    "stdout": "".join(stdout_chunks),
    "stderr": "".join(stderr_chunks),
}))
`.trim();
}
export function assertPythonKernel(kernelName) {
    if (!kernelName.toLowerCase().includes('python')) {
        throw new RemoteJupyterError('unsupported_kernel', `run_command requires a Python kernel, got ${kernelName}`);
    }
}
