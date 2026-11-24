import { useCallback, useEffect, useState } from 'react';

export type VelDriveSource = 'gps' | 'ble_gps' | 'simulator';
export type VelSimMultiplier = 1 | 2 | 4;

export interface VelocityPrefs {
  autoDetectTrack: boolean;
  autoDetectRadiusM: number;
  autoSnapHdop: boolean;
  useDeviceImu: boolean;
}

export interface VelocityEngineConfig extends VelocityPrefs {
  source: VelDriveSource;
  simMultiplier: VelSimMultiplier;
}

export const VEL_PREFS_KEY = 'pitstop_velocity_prefs_v3';
const VEL_SOURCE_KEY = 'pitstop_velocity_source_v1';
const VEL_PREFS_EVENT = 'pitstop:velocity-engine-prefs-updated';

export const DEFAULT_VEL_PREFS: VelocityPrefs = {
  autoDetectTrack: true,
  autoDetectRadiusM: 35,
  autoSnapHdop: true,
  useDeviceImu: true,
};

export function loadVelocityEngineConfig(): VelocityEngineConfig {
  let prefs: VelocityPrefs = DEFAULT_VEL_PREFS;
  let source: VelDriveSource = 'gps';
  let simMultiplier: VelSimMultiplier = 1;

  try {
    const rawPrefs = localStorage.getItem(VEL_PREFS_KEY);
    if (rawPrefs) {
      prefs = { ...DEFAULT_VEL_PREFS, ...(JSON.parse(rawPrefs) as Partial<VelocityPrefs>) };
    }
  } catch {
    // Ignore storage error
  }

  try {
    const rawSrc = localStorage.getItem(VEL_SOURCE_KEY);
    if (rawSrc) {
      const parsed = JSON.parse(rawSrc) as Partial<{
        source: VelDriveSource;
        simMultiplier: number;
      }>;
      if (parsed.source === 'gps' || parsed.source === 'ble_gps' || parsed.source === 'simulator') {
        source = parsed.source;
      }
      if (parsed.simMultiplier === 1 || parsed.simMultiplier === 2 || parsed.simMultiplier === 4) {
        simMultiplier = parsed.simMultiplier;
      }
    }
  } catch {
    // Ignore storage error
  }

  return {
    ...prefs,
    source,
    simMultiplier,
  };
}

export function saveVelocityEngineConfig(next: VelocityEngineConfig): void {
  const prefsOnly: VelocityPrefs = {
    autoDetectTrack: next.autoDetectTrack,
    autoDetectRadiusM: next.autoDetectRadiusM,
    autoSnapHdop: next.autoSnapHdop,
    useDeviceImu: next.useDeviceImu,
  };
  try {
    localStorage.setItem(VEL_PREFS_KEY, JSON.stringify(prefsOnly));
    localStorage.setItem(
      VEL_SOURCE_KEY,
      JSON.stringify({ source: next.source, simMultiplier: next.simMultiplier })
    );
    window.dispatchEvent(
      new CustomEvent<VelocityEngineConfig>(VEL_PREFS_EVENT, { detail: next })
    );
  } catch {
    // Ignore storage quota errors
  }
}

export function useVelocityEngineConfig() {
  const [config, setConfig] = useState<VelocityEngineConfig>(() => loadVelocityEngineConfig());

  useEffect(() => {
    const handleCustom = (ev: Event) => {
      const detail = (ev as CustomEvent<VelocityEngineConfig>).detail;
      if (detail) {
        setConfig(detail);
      } else {
        setConfig(loadVelocityEngineConfig());
      }
    };
    const handleStorage = (ev: StorageEvent) => {
      if (ev.key === VEL_PREFS_KEY || ev.key === VEL_SOURCE_KEY) {
        setConfig(loadVelocityEngineConfig());
      }
    };
    window.addEventListener(VEL_PREFS_EVENT, handleCustom);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(VEL_PREFS_EVENT, handleCustom);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const updateConfig = useCallback(
    (
      updater:
        | Partial<VelocityEngineConfig>
        | ((prev: VelocityEngineConfig) => VelocityEngineConfig)
    ) => {
      setConfig((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
        saveVelocityEngineConfig(next);
        return next;
      });
    },
    []
  );

  return [config, updateConfig] as const;
}
