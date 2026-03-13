export type JupyterContentType = 'directory' | 'file' | 'notebook';
export type BackendKind = 'remote-jupyter' | 'vscode-host';
export interface JupyterApiInfo {
    version?: string;
}
export interface JupyterKernelSpec {
    name?: string;
    display_name?: string;
    language?: string;
}
export interface JupyterNotebook {
    cells: JupyterCell[];
    metadata: {
        kernelspec?: JupyterKernelSpec;
        language_info?: Record<string, unknown>;
        [key: string]: unknown;
    };
    nbformat: number;
    nbformat_minor: number;
}
export interface JupyterBaseContentModel {
    name?: string;
    path: string;
    type: JupyterContentType;
    writable?: boolean;
    created?: string | null;
    last_modified?: string | null;
    mimetype?: string | null;
    format?: string | null;
}
export interface JupyterFileContentModel extends JupyterBaseContentModel {
    type: 'file';
    content?: string | null;
}
export interface JupyterDirectoryContentModel extends JupyterBaseContentModel {
    type: 'directory';
    content?: JupyterContentModel[] | null;
}
export interface JupyterNotebookContentModel extends JupyterBaseContentModel {
    type: 'notebook';
    content?: JupyterNotebook | null;
}
export type JupyterContentModel = JupyterFileContentModel | JupyterDirectoryContentModel | JupyterNotebookContentModel;
export interface JupyterSessionModel {
    id: string;
    path: string;
    name?: string;
    type?: string;
    kernel: {
        id: string;
        name: string;
    };
}
export interface JupyterCellBase {
    cell_type: 'code' | 'markdown' | 'raw';
    metadata: Record<string, unknown>;
    source: string | string[];
}
export interface JupyterCodeCell extends JupyterCellBase {
    cell_type: 'code';
    execution_count: number | null;
    outputs: JupyterCellOutput[];
}
export interface JupyterMarkdownCell extends JupyterCellBase {
    cell_type: 'markdown';
}
export interface JupyterRawCell extends JupyterCellBase {
    cell_type: 'raw';
}
export type JupyterCell = JupyterCodeCell | JupyterMarkdownCell | JupyterRawCell;
export type JupyterCellOutput = {
    output_type: 'stream';
    name: 'stdout' | 'stderr';
    text: string | string[];
} | {
    output_type: 'display_data' | 'execute_result';
    data: Record<string, unknown>;
    metadata: Record<string, unknown>;
    execution_count?: number | null;
} | {
    output_type: 'error';
    ename: string;
    evalue: string;
    traceback: string[];
};
export interface CachedSession {
    sessionId: string;
    kernelId: string;
    kernelName: string;
    path: string;
}
export interface ExecutionResult {
    status: 'ok' | 'error';
    stdout: string;
    stderr: string;
    rich_outputs: Array<{
        output_type: 'display_data' | 'execute_result';
        data: Record<string, unknown>;
        metadata: Record<string, unknown>;
        execution_count?: number | null;
    }>;
    outputs: JupyterCellOutput[];
    execution_count: number | null;
    error?: {
        ename: string;
        evalue: string;
        traceback: string[];
    };
}
export interface ConnectRemoteJupyterInput {
    jupyter_base_url?: string;
    jupyter_host?: string;
    jupyter_port?: number;
    jupyter_protocol?: 'http' | 'https';
    jupyter_token?: string;
    jupyter_base_path?: string;
}
export interface ConnectVscodeHostInput {
    host?: string;
    port: number;
    token: string;
    secure?: boolean;
}
export interface VscodeHostCapabilities {
    jupyter_extension_available: boolean;
    kernel_selected: boolean;
    can_execute_code: boolean;
    can_run_command: boolean;
}
export type VsCodeHostCapabilities = VscodeHostCapabilities;
export interface VsCodeHostInfo {
    host: string;
    port: number;
    extension_id: string;
    extension_version: string;
    capabilities: VscodeHostCapabilities;
}
export interface ConnectionStatus {
    connection_id: string;
    backend: BackendKind;
    base_url?: string;
    host?: string;
    port?: number;
    jupyter_status?: 'ok' | 'error';
    jupyter_error?: string | null;
    cached_sessions?: CachedSession[];
    capabilities?: VscodeHostCapabilities;
}
