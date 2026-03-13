import { z } from 'zod/v4';
export interface ActionDefinition {
    name: string;
    cliName: string;
    description: string;
    inputSchema: z.ZodTypeAny;
}
export declare const connectRemoteJupyterInputSchema: z.ZodObject<{
    jupyter_base_url: z.ZodOptional<z.ZodString>;
    jupyter_host: z.ZodOptional<z.ZodString>;
    jupyter_port: z.ZodDefault<z.ZodNumber>;
    jupyter_protocol: z.ZodDefault<z.ZodEnum<{
        http: "http";
        https: "https";
    }>>;
    jupyter_token: z.ZodOptional<z.ZodString>;
    jupyter_base_path: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export declare const connectVscodeHostInputSchema: z.ZodObject<{
    host: z.ZodDefault<z.ZodString>;
    port: z.ZodNumber;
    token: z.ZodString;
    secure: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export declare const actionDefinitions: readonly [ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition, ActionDefinition];
export declare const actionMap: Map<string, ActionDefinition>;
export declare const cliActionMap: Map<string, ActionDefinition>;
export declare function createRunCommandCode(command: string, cwd?: string, env?: Record<string, string>): string;
export declare function assertPythonKernel(kernelName: string): void;
