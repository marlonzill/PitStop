import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <span
      role="status"
      title="Modo Offline — GPS ativo local"
      aria-label="Modo Offline — GPS ativo local"
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-amber-500/35 bg-amber-500/12 px-2 text-[10px] font-bold text-amber-400"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      <WifiOff className="h-3 w-3 shrink-0" />
      <span className="hidden sm:inline">Offline</span>
    </span>
  );
};

