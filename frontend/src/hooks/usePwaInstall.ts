import { createContext, useContext } from 'react';

export interface PwaContextValue {
  canInstall: boolean;
  install: () => Promise<void>;
  isStandalone: boolean;
  needsManualInstall: boolean;
}

export const PwaContext = createContext<PwaContextValue | null>(null);

export function usePwaInstall(): PwaContextValue {
  const value = useContext(PwaContext);
  if (!value) {
    throw new Error('usePwaInstall must be used inside PwaProvider');
  }
  return value;
}
