import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export type ResolveCodexExecutableOptions = {
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  accessSync?: (path: string, mode?: number) => void;
  shellLookup?: () => string | null;
};

export function resolveCodexExecutable(options: ResolveCodexExecutableOptions = {}): string {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const accessSync = options.accessSync ?? fs.accessSync;
  const shellLookup = options.shellLookup ?? defaultShellLookup;

  const candidates = new Set<string>();
  const envCodexBin = env.CODEX_BIN?.trim();
  if (envCodexBin) candidates.add(envCodexBin);

  const envPath = env.PATH ?? '';
  if (envPath) {
    for (const dir of envPath.split(path.delimiter)) {
      const trimmed = dir.trim();
      if (!trimmed) continue;
      candidates.add(path.join(trimmed, process.platform === 'win32' ? 'codex.exe' : 'codex'));
    }
  }

  candidates.add('/opt/homebrew/bin/codex');
  candidates.add('/usr/local/bin/codex');
  candidates.add(path.join(os.homedir(), '.local', 'bin', 'codex'));

  const shellFound = shellLookup()?.trim();
  if (shellFound) candidates.add(shellFound);

  for (const candidate of candidates) {
    if (isExecutable(candidate, existsSync, accessSync)) return candidate;
  }

  throw new Error('未找到 codex 可执行文件。请先安装 Codex CLI，并确保 VSCode 进程可访问 PATH 或设置 CODEX_BIN。');
}

function isExecutable(
  filePath: string,
  existsSync: (path: string) => boolean,
  accessSync: (path: string, mode?: number) => void
): boolean {
  if (!filePath) return false;
  try {
    if (!existsSync(filePath)) return false;
    accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultShellLookup(): string | null {
  if (process.platform === 'win32') return null;
  try {
    const result = spawnSync('/bin/zsh', ['-lc', 'command -v codex || true'], {
      encoding: 'utf8'
    });
    const output = `${result.stdout || ''}`.trim();
    return output.split(/\r?\n/).find(Boolean) || null;
  } catch {
    return null;
  }
}
