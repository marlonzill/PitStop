import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { Geolocation } from '@capacitor/geolocation';

export type PermissionStateLabel = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface AppPermissionsSnapshot {
  location: PermissionStateLabel;
  microphone: PermissionStateLabel;
  storage: PermissionStateLabel;
  bluetooth: PermissionStateLabel;
}

const BOOTSTRAP_FLAG_KEY = 'pitstop_permissions_bootstrapped_v1';

interface NavigatorExtended extends Navigator {
  bluetooth?: {
    getAvailability?: () => Promise<boolean>;
    requestDevice?: (opts: unknown) => Promise<unknown>;
  };
}

interface WindowExtended extends Window {
  showDirectoryPicker?: () => Promise<unknown>;
}

export async function checkAllPermissionsStatus(): Promise<AppPermissionsSnapshot> {
  const result: AppPermissionsSnapshot = {
    location: 'prompt',
    microphone: 'prompt',
    storage: 'prompt',
    bluetooth: 'prompt',
  };

  // Location
  try {
    if (Capacitor.isNativePlatform()) {
      const p = await Geolocation.checkPermissions();
      result.location =
        p.location === 'granted' || p.coarseLocation === 'granted'
          ? 'granted'
          : p.location === 'denied'
            ? 'denied'
            : 'prompt';
    } else if ('permissions' in navigator) {
      const q = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
      result.location = q.state === 'granted' ? 'granted' : q.state === 'denied' ? 'denied' : 'prompt';
    } else if (!('geolocation' in navigator)) {
      result.location = 'unsupported';
    }
  } catch {
    // Keep prompt
  }

  // Microphone
  try {
    const nav = globalThis.navigator as Navigator | undefined;
    const perms = nav?.permissions;
    if (perms && typeof perms.query === 'function') {
      const q = await perms.query({ name: 'microphone' as PermissionName });
      result.microphone = q.state === 'granted' ? 'granted' : q.state === 'denied' ? 'denied' : 'prompt';
    } else if (!nav?.mediaDevices?.getUserMedia) {
      result.microphone = 'unsupported';
    }
  } catch {
    const nav = globalThis.navigator as Navigator | undefined;
    if (!nav?.mediaDevices?.getUserMedia) {
      result.microphone = 'unsupported';
    }
  }

  // Storage / Folders
  try {
    if (Capacitor.isNativePlatform()) {
      const p = await Filesystem.checkPermissions();
      result.storage =
        p.publicStorage === 'granted'
          ? 'granted'
          : p.publicStorage === 'denied'
            ? 'denied'
            : 'prompt';
    } else {
      const winExt = window as WindowExtended;
      result.storage =
        typeof winExt.showDirectoryPicker === 'function' || typeof File !== 'undefined'
          ? 'granted'
          : 'unsupported';
    }
  } catch {
    result.storage = Capacitor.isNativePlatform() ? 'prompt' : 'granted';
  }

  // Bluetooth
  try {
    const navExt = navigator as NavigatorExtended;
    if (navExt.bluetooth) {
      if (typeof navExt.bluetooth.getAvailability === 'function') {
        const avail = await navExt.bluetooth.getAvailability();
        result.bluetooth = avail ? 'granted' : 'prompt';
      } else {
        result.bluetooth = 'prompt';
      }
    } else {
      result.bluetooth = Capacitor.isNativePlatform() ? 'prompt' : 'unsupported';
    }
  } catch {
    result.bluetooth = 'prompt';
  }

  return result;
}

export async function requestMissingPermissions(options?: {
  includeMicrophonePrompt?: boolean;
}): Promise<AppPermissionsSnapshot> {
  // 1. Location (Native & Web)
  try {
    if (Capacitor.isNativePlatform()) {
      await Geolocation.requestPermissions();
    } else if ('geolocation' in navigator) {
      await new Promise<void>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve(),
          () => resolve(),
          { enableHighAccuracy: true, timeout: 4000, maximumAge: 60000 }
        );
      });
    }
  } catch {
    // Ignore denied/timeout
  }

  // 2. Storage / Folders (Android Native Filesystem permission)
  try {
    if (Capacitor.isNativePlatform()) {
      await Filesystem.requestPermissions();
    }
  } catch {
    // Ignore storage denial
  }

  // 3. Microphone (only actively prompt when user clicked permission button or voice-recording prompt enabled)
  if (options?.includeMicrophonePrompt && navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((tr) => tr.stop());
    } catch {
      // Ignore microphone denial
    }
  }

  return checkAllPermissionsStatus();
}

export function bootstrapFirstRunPermissions(): void {
  if (typeof window === 'undefined') return;
  try {
    if (window.localStorage.getItem(BOOTSTRAP_FLAG_KEY) === '1') {
      return;
    }
    window.localStorage.setItem(BOOTSTRAP_FLAG_KEY, '1');
  } catch {
    // Ignore storage error
  }

  // Request Location + Storage silently after initial paint (microphone is requested only on user gesture)
  window.setTimeout(() => {
    requestMissingPermissions({
      includeMicrophonePrompt: false,
    }).catch(() => {});
  }, 600);
}
