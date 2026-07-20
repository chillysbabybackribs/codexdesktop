export const alwaysKeepAllStorageKey = 'codexdesktop.alwaysKeepAll';

export function isAlwaysKeepAllStored(value: string | null): boolean {
  return value === '1';
}

export function storedAlwaysKeepAllValue(enabled: boolean): '1' | '0' {
  return enabled ? '1' : '0';
}
