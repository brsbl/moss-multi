// Credentials and server (A§17): MOSS_MULTI_API_KEY and MOSS_MULTI_SERVER win over ~/.config/moss-multi/config.json,
// which `login` writes at mode 0600. An agent key attributes work to the agent; a device-flow session to the person.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fetchNoRedirect } from './api.ts';
import { CliError } from './errors.ts';

/** The client id the server's deviceAuthorization plugin accepts. */
export const DEVICE_CLIENT_ID = 'moss-multi-cli';

export interface CliConfig {
  serverUrl: string | null;
  apiKey?: string;
  sessionToken?: string;
}

interface ConfigFile {
  serverUrl?: string;
  apiKey?: string;
  sessionToken?: string;
}

type Env = Record<string, string | undefined>;

export function configDir(env: Env): string {
  return env.MOSS_MULTI_CONFIG_DIR || join(homedir(), '.config', 'moss-multi');
}

export function configPath(env: Env): string {
  return join(configDir(env), 'config.json');
}

function readConfigFile(env: Env): ConfigFile {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ConfigFile) : {};
  } catch {
    return {};
  }
}

function writeConfigFile(env: Env, next: ConfigFile): string {
  mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
  const path = configPath(env);
  // A fresh 0600 file renamed over the old one: the credential is never written into a file with looser permissions.
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return path;
}

export const normalizeServer = (url: string): string => url.trim().replace(/\/+$/, '');

export function resolveConfig(env: Env): CliConfig {
  const file = readConfigFile(env);
  const server = env.MOSS_MULTI_SERVER || file.serverUrl;
  const apiKey = env.MOSS_MULTI_API_KEY || file.apiKey;
  return {
    serverUrl: server ? normalizeServer(server) : null,
    ...(apiKey ? { apiKey } : {}),
    ...(file.sessionToken ? { sessionToken: file.sessionToken } : {}),
  };
}

/** Merges `patch` into the config file; a credential replaces the other kind. */
export function writeConfig(env: Env, patch: ConfigFile): string {
  const current = readConfigFile(env);
  const next: ConfigFile = { ...current, ...patch };
  if (patch.apiKey) delete next.sessionToken;
  if (patch.sessionToken) delete next.apiKey;
  return writeConfigFile(env, next);
}

/** Drops stored credentials, keeping the server; returns the session token that was stored, to revoke it. */
export function clearCredentials(env: Env): { hadCredentials: boolean; sessionToken?: string } {
  const file = readConfigFile(env);
  const hadCredentials = Boolean(file.apiKey || file.sessionToken);
  if (existsSync(configPath(env))) writeConfigFile(env, file.serverUrl ? { serverUrl: file.serverUrl } : {});
  return { hadCredentials, ...(file.sessionToken ? { sessionToken: file.sessionToken } : {}) };
}

export interface DeviceLoginIO {
  fetchImpl: typeof fetch;
  out: (line: string) => void;
  openUrl?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Whether the CLI may open a browser: not when MOSS_MULTI_NO_OPEN=1 (QA and scripts) or on CI. */
export const mayOpenBrowser = (env: NodeJS.ProcessEnv = process.env): boolean => env.MOSS_MULTI_NO_OPEN !== '1' && !env.CI;

/** `open` on macOS, `xdg-open` elsewhere; a headless machine, CI or MOSS_MULTI_NO_OPEN=1 just uses the printed URL. */
function defaultOpenUrl(url: string): void {
  if (!mayOpenBrowser()) return;
  try {
    const child = spawn(platform() === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The printed URL is the fallback.
  }
}

/** `uri` resolved against the server, if it is an http(s) page on the server's own origin; anything else is null. */
function ownPage(serverUrl: string, uri: unknown): string | null {
  if (typeof uri !== 'string') return null;
  try {
    const url = new URL(uri, `${serverUrl}/`);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === new URL(serverUrl).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface DeviceGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/**
 * RFC 8628 against better-auth's deviceAuthorization plugin: request a code, print where to approve it, poll at the
 * server's interval (slow_down adds 5 s) until approved, denied or expired. Returns the session token.
 */
export async function deviceLogin(serverUrl: string, io: DeviceLoginIO): Promise<string> {
  const sleep = io.sleep ?? defaultSleep;
  const openUrl = io.openUrl ?? defaultOpenUrl;
  const post = (path: string, body: unknown) => fetchNoRedirect(io.fetchImpl, `${serverUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const started = await post('/api/auth/device/code', { client_id: DEVICE_CLIENT_ID });
  if (!started.ok) {
    throw new CliError(1, `device sign-in is unavailable at ${serverUrl} (HTTP ${started.status}); use \`moss-multi login --key <mm_sk_...>\``);
  }
  const grant = (await started.json()) as DeviceGrant;
  const userCode = String(grant.user_code);
  const page = ownPage(serverUrl, grant.verification_uri) ?? `${serverUrl}/device`;
  const complete = ownPage(serverUrl, grant.verification_uri_complete ?? `${grant.verification_uri}?user_code=${encodeURIComponent(userCode)}`);
  if (complete) {
    io.out('To sign in, open:');
    io.out(`  ${complete}`);
    io.out(`and confirm the code ${userCode} (or enter it at ${page}).`);
    openUrl(complete);
  } else {
    io.out(`To sign in, open ${page} and enter the code ${userCode}.`);
  }

  const deadline = Date.now() + grant.expires_in * 1000;
  let interval = Math.max(1, grant.interval) * 1000;
  for (;;) {
    await sleep(interval);
    if (Date.now() >= deadline) throw new CliError(1, 'the code expired before it was approved: run `moss-multi login` again');
    const polled = await post('/api/auth/device/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: grant.device_code,
      client_id: DEVICE_CLIENT_ID,
    });
    const body = (await polled.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (polled.ok) {
      if (!body.access_token) throw new CliError(1, 'the server returned no session: try again');
      return body.access_token;
    }
    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5000;
        continue;
      case 'expired_token':
        throw new CliError(1, 'the code expired before it was approved: run `moss-multi login` again');
      case 'access_denied':
        throw new CliError(1, 'sign-in was denied in the browser');
      default:
        throw new CliError(1, `sign-in failed (HTTP ${polled.status})${body.error_description ? `: ${body.error_description}` : ''}`);
    }
  }
}
