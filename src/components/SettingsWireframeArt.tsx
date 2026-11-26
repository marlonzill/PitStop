import React from 'react';
import type { SettingsSubMenu } from '../App';

interface SettingsWireframeArtProps {
  menuId: Exclude<SettingsSubMenu, 'hub'>;
  color: string;
}

export const SettingsWireframeArt: React.FC<SettingsWireframeArtProps> = ({ menuId, color }) => {
  const commonProps = {
    viewBox: '0 0 120 96',
    fill: 'none',
    stroke: color,
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style: { filter: `drop-shadow(0 0 4px ${color}55)` },
    className:
      'pointer-events-none absolute left-1.5 top-1/2 h-[48px] w-[56px] -translate-y-1/2 opacity-40 transition-opacity duration-200 group-hover:opacity-70 sm:left-2 sm:h-[58px] sm:w-[70px]',
    'aria-hidden': true,
  };

  switch (menuId) {
    case 'account':
      return (
        <svg {...commonProps}>
          {/* Technical Shield + Ignition Key Wireframe */}
          <path d="M44 16 L70 24 V48 C70 64 58 76 44 82 C30 76 18 64 18 48 V24 Z" />
          <path d="M44 24 L62 30 V48 C62 59 54 68 44 73" strokeDasharray="3 3" />
          <circle cx="44" cy="44" r="9" />
          <path d="M44 53 V66 M44 60 H50 M44 64 H49" />
          <path d="M8 20 H18 M8 74 H18" opacity="0.5" />
        </svg>
      );
    case 'modality':
      return (
        <svg {...commonProps}>
          {/* Checkered Rally Flag + Route Selector Wireframe */}
          <path d="M22 76 V20" />
          <path d="M22 22 C36 16 48 28 62 22 V48 C48 54 36 42 22 48" />
          <path d="M34 21 V47 M48 23 V49 M22 35 C36 29 48 41 62 35" strokeDasharray="3 2" />
          <path d="M62 68 C72 68 72 52 84 52" />
          <circle cx="62" cy="68" r="3" />
          <circle cx="86" cy="52" r="3.5" />
        </svg>
      );
    case 'velocity':
      return (
        <svg {...commonProps}>
          {/* Speedometer Tach Arc + GPS Telemetry Needle */}
          <path d="M18 62 A30 30 0 1 1 74 62" />
          <path d="M25 60 A22 22 0 1 1 67 60" strokeDasharray="3 3" />
          <path d="M46 54 L63 36" />
          <circle cx="46" cy="54" r="3.5" />
          <rect x="28" y="66" width="36" height="10" rx="2" />
          <path d="M78 24 H94 M86 16 V32" opacity="0.65" />
          <circle cx="86" cy="24" r="5" opacity="0.7" />
        </svg>
      );
    case 'theme':
      return (
        <svg {...commonProps}>
          {/* Gauge Cluster + Color Arc Wireframe */}
          <circle cx="46" cy="52" r="28" />
          <path d="M24 52 A22 22 0 1 1 68 52" strokeDasharray="3 2" />
          <path d="M46 52 L62 36" />
          <circle cx="46" cy="52" r="4" />
          <path d="M18 22 H74 M22 82 H70" opacity="0.55" />
          <circle cx="80" cy="30" r="6" />
          <circle cx="86" cy="48" r="5" />
        </svg>
      );
    case 'roadbooks':
      return (
        <svg {...commonProps}>
          {/* Topographic Contour Curves + Checkpoint Waypoints */}
          <path d="M6 74 C24 68 30 34 52 38 C72 42 74 18 96 16" />
          <path d="M6 58 C20 52 28 24 48 28 C66 32 70 10 92 10" strokeDasharray="4 3" />
          <path d="M10 86 C32 78 40 50 62 54 C78 57 86 38 102 36" opacity="0.7" />
          <circle cx="52" cy="38" r="4.5" />
          <path d="M52 24 V32 M44 38 H47 M57 38 H62" />
          <rect x="74" y="54" width="16" height="22" rx="2" />
          <path d="M78 61 H86 M78 66 H84" />
        </svg>
      );
    case 'collector':
      return (
        <svg {...commonProps}>
          {/* Satellite Telemetry Dish & Orbital Trajectory */}
          <circle cx="46" cy="48" r="26" strokeDasharray="2 3" />
          <ellipse cx="46" cy="48" rx="36" ry="14" transform="rotate(-24 46 48)" />
          <circle cx="46" cy="48" r="7" />
          <path d="M66 24 L78 12 M72 12 H78 V18" />
          <circle cx="24" cy="60" r="2.5" />
          <circle cx="72" cy="36" r="2.5" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...commonProps}>
          {/* Precision Chronograph Dial */}
          <circle cx="46" cy="48" r="28" />
          <circle cx="46" cy="48" r="22" strokeDasharray="2 4" />
          <path d="M46 14 V20 M46 76 V82 M12 48 H18 M74 48 H80" />
          <path d="M46 48 V30 M46 48 L60 56" />
          <circle cx="46" cy="48" r="3.5" />
          <path d="M38 12 H54" />
        </svg>
      );
    case 'pairing':
      return (
        <svg {...commonProps}>
          {/* Dual-Node Telemetry Link Diagram */}
          <rect x="14" y="28" width="22" height="38" rx="3" />
          <rect x="64" y="28" width="22" height="38" rx="3" />
          <path d="M36 42 H64 M36 52 H64" strokeDasharray="3 2" />
          <path d="M46 36 A14 14 0 0 1 54 36 M43 30 A22 22 0 0 1 57 30" />
          <circle cx="25" cy="47" r="3" />
          <circle cx="75" cy="47" r="3" />
        </svg>
      );
    case 'pilot':
      return (
        <svg {...commonProps}>
          {/* Cockpit HUD Grid & Horizon Bars */}
          <rect x="12" y="20" width="76" height="56" rx="4" />
          <path d="M12 36 H88 M44 36 V76" />
          <path d="M22 52 H34 M22 60 H36 M54 50 H76 M54 62 H70" />
          <path d="M18 28 H32 M64 28 H80" strokeDasharray="2 2" />
        </svg>
      );
    case 'calibration':
      return (
        <svg {...commonProps}>
          {/* Wheel Sensor Pulse & Precision Caliper */}
          <circle cx="44" cy="48" r="24" />
          <circle cx="44" cy="48" r="10" strokeDasharray="3 3" />
          <path d="M44 18 V24 M44 72 V78 M14 48 H20 M68 48 H74" />
          <path d="M74 26 H92 M78 26 V70 M74 70 H92 M78 38 H86 M78 50 H88 M78 62 H86" />
        </svg>
      );
    case 'alerts':
      return (
        <svg {...commonProps}>
          {/* Acoustic Waveform & Signal Peak Monitor */}
          <path d="M10 48 H22 L28 30 L36 68 L44 20 L52 74 L60 36 L68 56 L74 48 H92" />
          <path d="M10 22 H92 M10 74 H92" strokeDasharray="2 4" opacity="0.5" />
          <circle cx="44" cy="20" r="2.5" />
        </svg>
      );
    case 'gopro':
      return (
        <svg {...commonProps}>
          {/* Action Camera Blueprint */}
          <rect x="16" y="24" width="66" height="48" rx="6" />
          <circle cx="42" cy="48" r="15" />
          <circle cx="42" cy="48" r="8" strokeDasharray="3 2" />
          <rect x="64" y="34" width="11" height="10" rx="1.5" />
          <path d="M28 18 H40" />
          <circle cx="69" cy="58" r="3" />
        </svg>
      );
    case 'backup':
      return (
        <svg {...commonProps}>
          {/* Solid-State Storage Matrix Schematic */}
          <rect x="18" y="18" width="62" height="16" rx="2" />
          <rect x="18" y="40" width="62" height="16" rx="2" />
          <rect x="18" y="62" width="62" height="16" rx="2" />
          <circle cx="28" cy="26" r="2" />
          <circle cx="28" cy="48" r="2" />
          <circle cx="28" cy="70" r="2" />
          <path d="M38 26 H70 M38 48 H70 M38 70 H70" strokeDasharray="3 2" />
        </svg>
      );
    case 'system':
    default:
      return (
        <svg {...commonProps}>
          {/* PCB Gyro / Diagnostic Bus Grid */}
          <rect x="28" y="30" width="38" height="36" rx="3" />
          <rect x="37" y="39" width="20" height="18" rx="1.5" />
          <path d="M36 18 V30 M47 18 V30 M58 18 V30" />
          <path d="M36 66 V78 M47 66 V78 M58 66 V78" />
          <path d="M14 40 H28 M14 56 H28 M66 40 H82 M66 56 H82" />
        </svg>
      );
  }
};
