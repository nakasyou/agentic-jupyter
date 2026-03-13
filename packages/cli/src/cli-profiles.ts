import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod/v4'

const cliProfileSchema = z.object({
  backend: z.enum(['remote-jupyter', 'vscode-host']).default('remote-jupyter'),
  jupyter_base_url: z.string().optional(),
  jupyter_host: z.string().optional(),
  jupyter_port: z.number().int().positive().optional(),
  jupyter_protocol: z.enum(['http', 'https']).optional(),
  jupyter_token: z.string().optional(),
  jupyter_base_path: z.string().optional(),
  vscode_host: z.string().optional(),
  vscode_port: z.number().int().positive().optional(),
  vscode_token: z.string().optional(),
  vscode_secure: z.boolean().optional(),
  default_notebook_path: z.string().optional(),
})

const cliProfilesFileSchema = z.object({
  profiles: z.record(z.string(), cliProfileSchema).default({}),
})

export type CliProfile = z.output<typeof cliProfileSchema>
export type CliProfilesFile = z.output<typeof cliProfilesFileSchema>

function getConfigRoot(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

export function getProfilesPath(): string {
  return join(getConfigRoot(), 'agentic-jupyter', 'profiles.json')
}

async function ensureProfilesDirectory(): Promise<string> {
  const file = getProfilesPath()
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await chmod(directory, 0o700)
  } catch {}
  return file
}

export async function loadProfiles(): Promise<CliProfilesFile> {
  const file = getProfilesPath()
  try {
    const raw = await readFile(file, 'utf8')
    return cliProfilesFileSchema.parse(JSON.parse(raw))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {
        profiles: {},
      }
    }
    throw error
  }
}

export async function saveProfiles(data: CliProfilesFile): Promise<void> {
  const file = await ensureProfilesDirectory()
  await writeFile(file, JSON.stringify(data, null, 2))
  try {
    await chmod(file, 0o600)
  } catch {}
}

export async function setProfile(name: string, profile: CliProfile): Promise<CliProfile> {
  const data = await loadProfiles()
  data.profiles[name] = profile
  await saveProfiles(data)
  return profile
}

export async function getProfile(name: string): Promise<CliProfile | null> {
  const data = await loadProfiles()
  return data.profiles[name] ?? null
}

export async function listProfiles(): Promise<Record<string, CliProfile>> {
  const data = await loadProfiles()
  return data.profiles
}

export async function deleteProfile(name: string): Promise<boolean> {
  const data = await loadProfiles()
  if (!(name in data.profiles)) {
    return false
  }
  delete data.profiles[name]
  await saveProfiles(data)
  return true
}
