import * as vscode from 'vscode';
import type { PaletteColor, PreviewTheme } from './protocol';

export const SECTION = 'markdownAnnotate';

export const DEFAULT_PALETTE: PaletteColor[] = [
  { name: 'yellow', color: '#fde047' },
  { name: 'green', color: '#86efac' },
  { name: 'blue', color: '#93c5fd' },
  { name: 'pink', color: '#f9a8d4' },
  { name: 'orange', color: '#fdba74' },
  { name: 'purple', color: '#c4b5fd' },
];

function config(scope?: vscode.Uri) {
  return vscode.workspace.getConfiguration(SECTION, scope);
}

export function palette(): PaletteColor[] {
  const value = config().get<unknown>('colors');
  if (!Array.isArray(value)) {
    return DEFAULT_PALETTE;
  }
  const colors = value.filter(
    (c): c is PaletteColor =>
      !!c && typeof c.name === 'string' && typeof c.color === 'string' && /^[\w-]+$/.test(c.name),
  );
  return colors.length ? colors : DEFAULT_PALETTE;
}

export function colorOf(name: string): string {
  return palette().find((c) => c.name === name)?.color ?? DEFAULT_PALETTE[0].color;
}

export function writeToFile(scope?: vscode.Uri): boolean {
  return config(scope).get<boolean>('writeToFile', false);
}

export async function setWriteToFile(value: boolean): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await config().update('writeToFile', value, target);
}

export function previewTheme(): PreviewTheme {
  const value = config().get<string>('previewTheme', 'auto');
  return value === 'light' || value === 'dark' ? value : 'auto';
}

/** A reading preference, so it follows the user across workspaces. */
export async function setPreviewTheme(value: PreviewTheme): Promise<void> {
  await config().update('previewTheme', value === 'auto' ? undefined : value, vscode.ConfigurationTarget.Global);
}

export function inlineStyles(): boolean {
  return config().get<boolean>('fileMarks.inlineStyle', true);
}

export type StorageMode = 'workspace' | 'sidecar';

export function storageMode(): StorageMode {
  return config().get<StorageMode>('storage', 'workspace');
}

export function showInEditor(): boolean {
  return config().get<boolean>('showInEditor', true);
}

/** Whether a newly opened preview syncs its scrolling with the editor; each preview then has its own toggle. */
export function scrollSync(): boolean {
  return config().get<boolean>('scrollSync', true);
}

/** Inline CSS written into `<mark>` tags so other renderers show the colour. */
export function markStyle(color: string): string | undefined {
  return inlineStyles() ? `background-color:${colorOf(color)};color:#1f2328` : undefined;
}

/** `#rrggbb` → `rgba(r, g, b, alpha)`; other CSS colours are returned as-is. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) {
    return color;
  }
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
