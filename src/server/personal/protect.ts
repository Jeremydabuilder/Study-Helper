import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Where the saved ChatGPT connection lives matters more than what is in it. Two protections, both best effort and both explained to the person:
 *  - a folder that a cloud-sync client copies (OneDrive, Dropbox, iCloud, Google Drive…) would put a long-lived refresh token in someone else's storage
 *  - on Windows, POSIX file modes do nothing, so the folder is restricted to the signed-in user with icacls
 */
const SYNCED = /(^|[\\/])(onedrive[^\\/]*|dropbox[^\\/]*|icloud ?drive|iclouddrive|mobile documents|google ?drive|googledrive|box sync|box|pcloud ?drive|megasync|sync\.com|nextcloud|syncthing)([\\/]|$)/i;

export function syncedFolderWarning(dir: string): string | null {
  const full = resolve(dir);
  return SYNCED.test(full) ? `The ChatGPT connection folder (${full}) looks like it is inside a cloud-synced folder, which would copy your saved sign-in to that service. Set CHATGPT_AUTH_DIR to a private folder that is not synced (see docs/PERSONAL_CHATGPT.md).` : null;
}

type Runner = (cmd: string, args: string[], o: { encoding: 'utf8'; windowsHide: boolean; timeout: number }) => { status: number | null; error?: Error };

/** Windows only: remove inherited permissions and grant full control to the current user (and the system account) alone. */
export function restrictToCurrentUser(dir: string, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: Runner } = {}): { ok: boolean; note: string | null } {
  if ((o.platform ?? process.platform) !== 'win32') return { ok: true, note: null };
  const env = o.env ?? process.env, user = env.USERNAME ? `${env.USERDOMAIN ? `${env.USERDOMAIN}\\` : ''}${env.USERNAME}` : null;
  if (!user) return { ok: false, note: 'Could not tell which Windows user is running Study Helper, so the folder permissions were not tightened.' };
  const run = o.run ?? (spawnSync as unknown as Runner);
  const r = run('icacls', [resolve(dir), '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return r.status === 0 && !r.error ? { ok: true, note: null } : { ok: false, note: 'Windows would not let Study Helper restrict the connection folder to your account. Keep it in a folder only you can open.' };
}
