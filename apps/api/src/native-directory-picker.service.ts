import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);

@Injectable()
export class NativeDirectoryPickerService {
  async pickDirectory(): Promise<{ path: string | null }> {
    try {
      const selected = await pickDirectoryForPlatform(platform());
      return { path: normalizeSelection(selected) };
    } catch (error) {
      if (platform() === 'linux' && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new ServiceUnavailableException('未检测到 zenity，无法打开系统目录选择器。请手动输入项目绝对路径。');
      const message = error instanceof Error ? error.message : '无法打开系统目录选择器。';
      throw new ServiceUnavailableException(message);
    }
  }
}

export async function pickDirectoryForPlatform(os: NodeJS.Platform): Promise<string> {
  if (os === 'darwin') {
    const script = 'try\nPOSIX path of (choose folder with prompt "选择 Dockyard 项目目录")\non error number -128\nreturn ""\nend try';
    return (await execute('osascript', ['-e', script], { timeout: 120_000, windowsHide: true })).stdout;
  }
  if (os === 'win32') {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "选择 Dockyard 项目目录"; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }';
    return (await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 120_000, windowsHide: true })).stdout;
  }
  if (os === 'linux') return (await execute('zenity', ['--file-selection', '--directory', '--title=选择 Dockyard 项目目录'], { timeout: 120_000, windowsHide: true })).stdout;
  throw new Error(`当前平台 ${os} 不支持系统目录选择器。请手动输入绝对路径。`);
}

export function normalizeSelection(value: string): string | null {
  const path = value.trim();
  if (!path || path === '/' || /^[A-Za-z]:[\\/]$/u.test(path)) return path || null;
  return path.replace(/[\\/]$/u, '') || path;
}
