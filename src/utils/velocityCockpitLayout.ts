import { useCallback, useEffect, useState } from 'react';

export type VelocityCockpitLayoutId =
  | 'classic'
  | 'thumb_zone'
  | 'coralba'
  | 'split_map'
  | 'aim_minimal'
  | 'ft700_cluster'
  | 'harrys_delta'
  | 'wrc_pacenote'
  | 'night_stage'
  | 'landscape_3col'
  | 'custom';

export type VelocityMenuPosition = 'bottom' | 'top';

export type CustomWidgetId =
  | 'delta'
  | 'splits'
  | 'speed'
  | 'meters'
  | 'chrono'
  | 'minimap';

export type CustomWidgetSize = 'P' | 'M' | 'G';

export interface CustomWidgetConfig {
  id: CustomWidgetId;
  label: string;
  description: string;
  enabled: boolean;
  size: CustomWidgetSize;
}

export interface VelocityCockpitLayoutConfig {
  layoutId: VelocityCockpitLayoutId;
  menuPosition: VelocityMenuPosition;
  customWidgets: CustomWidgetConfig[];
}

export interface VelocityCockpitLayoutPreset {
  id: VelocityCockpitLayoutId;
  code: string;
  name: string;
  shortName: string;
  tag: string;
  accentColor: string;
  description: string;
}

export const VELOCITY_COCKPIT_LAYOUT_KEY = 'pitstop_velocity_cockpit_layout_v1';
const VELOCITY_COCKPIT_LAYOUT_EVENT = 'pitstop:velocity-cockpit-layout-updated';

export const VELOCITY_COCKPIT_PRESETS: VelocityCockpitLayoutPreset[] = [
  {
    id: 'classic',
    code: '01',
    name: 'PitStop Clássico (Atual)',
    shortName: 'Clássico',
    tag: 'Padrão Clássico',
    accentColor: '#E10600',
    description: 'Delta Time em largura total, janela P1–P4, velocidade, odômetro e cronômetro.',
  },
  {
    id: 'thumb_zone',
    code: '02',
    name: 'Ergonomia Thumb-Zone',
    shortName: 'Thumb-Zone',
    tag: 'Equilibrado',
    accentColor: '#10B981',
    description: 'Dados centrais limpos e compactos: Delta Time, Parciais, Velocidade, Metros e Cronômetro.',
  },
  {
    id: 'coralba',
    code: '03',
    name: 'Coralba / Monit Rally',
    shortName: 'Coralba Rally',
    tag: 'Navegador',
    accentColor: '#F59E0B',
    description: 'Odômetro Parcial (Trip) gigante em destaque, Odômetro Total, Hora CH, Velocidade e SS.',
  },
  {
    id: 'split_map',
    code: '04',
    name: 'RaceChrono Split-Screen',
    shortName: 'Split Mapa',
    tag: 'Mapa + Dados',
    accentColor: '#0EA5E9',
    description: 'Metade superior com Mapa ao Vivo em tempo real e metade inferior com Delta, Vel. e Trip.',
  },
  {
    id: 'aim_minimal',
    code: '05',
    name: 'AiM Solo 2 (Minimalista)',
    shortName: 'AiM Solo 2',
    tag: '3 Blocos',
    accentColor: '#A3E635',
    description: 'Estritamente 3 blocos gigantes de alto contraste: Delta Time, Cronômetro e Velocidade.',
  },
  {
    id: 'ft700_cluster',
    code: '06',
    name: 'FuelTech FT700 Cluster',
    shortName: 'FT700 Cluster',
    tag: 'Painel Digital',
    accentColor: '#00E5FF',
    description: 'Barra de LED superior, Velocidade + Delta proeminentes no centro e faixa P1–P4 + Metros.',
  },
  {
    id: 'harrys_delta',
    code: '07',
    name: "Harry's LapTimer",
    shortName: "Harry's Delta",
    tag: 'Visão Periférica',
    accentColor: '#22C55E',
    description: 'Bloco gigante de Delta ocupando ~45% do centro em verde ou vermelho vivo.',
  },
  {
    id: 'wrc_pacenote',
    code: '08',
    name: 'WRC Pace-Note',
    shortName: 'WRC Metragem',
    tag: 'Metros Colossal',
    accentColor: '#F97316',
    description: 'Metros percorridos em fonte colossal, distância restante até a chegada e velocidade.',
  },
  {
    id: 'night_stage',
    code: '09',
    name: 'Night Stage (Endurance)',
    shortName: 'Noturno',
    tag: 'Zero Ofuscamento',
    accentColor: '#94A3B8',
    description: 'Fundo preto puro (#000000), bordas sutis e números bem espaçados para etapa noturna.',
  },
  {
    id: 'landscape_3col',
    code: '10',
    name: 'Cockpit Horizontal',
    shortName: 'Paisagem 3 Col',
    tag: 'Paisagem / Tablet',
    accentColor: '#38BDF8',
    description: 'Grid largo em 3 colunas otimizado para celular deitado ou tablet no painel.',
  },
  {
    id: 'custom',
    code: '11',
    name: 'Customizado (Monte o Seu)',
    shortName: 'Customizado',
    tag: 'Editor Visual',
    accentColor: '#A855F7',
    description: 'Ative/desative widgets de dados, ordene com Subir/Descer e escolha tamanho P, M ou G.',
  },
];

export function getDefaultCustomWidgets(): CustomWidgetConfig[] {
  return [
    {
      id: 'delta',
      label: 'Barra de Delta',
      description: 'Barra preditiva + caixa MAIS RÁPIDO / MAIS LENTO',
      enabled: true,
      size: 'M',
    },
    {
      id: 'splits',
      label: 'Parciais (P1–P4)',
      description: 'Janela deslizante de 4 setores com diferença real',
      enabled: true,
      size: 'P',
    },
    {
      id: 'speed',
      label: 'Velocidade',
      description: 'Velocímetro digital em km/h',
      enabled: true,
      size: 'M',
    },
    {
      id: 'meters',
      label: 'Metros (Odômetro)',
      description: 'Trip parcial em metros e km (toque para editar)',
      enabled: true,
      size: 'M',
    },
    {
      id: 'chrono',
      label: 'Cronômetro & CH',
      description: 'Tempo da especial, hora oficial CH, Melhor e Última',
      enabled: true,
      size: 'M',
    },
    {
      id: 'minimap',
      label: 'Mini-Mapa ao Vivo',
      description: 'Traçado da especial com posição GPS em tempo real',
      enabled: false,
      size: 'M',
    },
  ];
}

export function getDefaultVelocityCockpitLayout(): VelocityCockpitLayoutConfig {
  return {
    layoutId: 'classic',
    menuPosition: 'bottom',
    customWidgets: getDefaultCustomWidgets(),
  };
}

function normalizeCustomWidgets(rawList: unknown): CustomWidgetConfig[] {
  const defaults = getDefaultCustomWidgets();
  if (!Array.isArray(rawList)) return defaults;
  const byId = new Map(defaults.map((w) => [w.id, w]));
  const result: CustomWidgetConfig[] = [];
  const seen = new Set<CustomWidgetId>();

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<CustomWidgetConfig>;
    if (!candidate.id || !byId.has(candidate.id) || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const def = byId.get(candidate.id)!;
    const size: CustomWidgetSize =
      candidate.size === 'P' || candidate.size === 'M' || candidate.size === 'G'
        ? candidate.size
        : def.size;
    result.push({
      id: def.id,
      label: def.label,
      description: def.description,
      enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : def.enabled,
      size,
    });
  }

  for (const def of defaults) {
    if (!seen.has(def.id)) result.push(def);
  }
  return result;
}

export function loadVelocityCockpitLayout(): VelocityCockpitLayoutConfig {
  const defaults = getDefaultVelocityCockpitLayout();
  try {
    const raw = localStorage.getItem(VELOCITY_COCKPIT_LAYOUT_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<VelocityCockpitLayoutConfig>;
    const validIds = new Set(VELOCITY_COCKPIT_PRESETS.map((p) => p.id));
    const layoutId: VelocityCockpitLayoutId =
      parsed.layoutId && validIds.has(parsed.layoutId) ? parsed.layoutId : defaults.layoutId;
    const menuPosition: VelocityMenuPosition =
      parsed.menuPosition === 'top' || parsed.menuPosition === 'bottom'
        ? parsed.menuPosition
        : defaults.menuPosition;
    return {
      layoutId,
      menuPosition,
      customWidgets: normalizeCustomWidgets(parsed.customWidgets),
    };
  } catch {
    return defaults;
  }
}

export function saveVelocityCockpitLayout(config: VelocityCockpitLayoutConfig): void {
  try {
    localStorage.setItem(VELOCITY_COCKPIT_LAYOUT_KEY, JSON.stringify(config));
    window.dispatchEvent(
      new CustomEvent<VelocityCockpitLayoutConfig>(VELOCITY_COCKPIT_LAYOUT_EVENT, {
        detail: config,
      })
    );
  } catch {
    // Ignore storage quota errors
  }
}

export function getPresetMeta(layoutId: VelocityCockpitLayoutId): VelocityCockpitLayoutPreset {
  return (
    VELOCITY_COCKPIT_PRESETS.find((p) => p.id === layoutId) ?? VELOCITY_COCKPIT_PRESETS[0]
  );
}

export function useVelocityCockpitLayout() {
  const [config, setConfig] = useState<VelocityCockpitLayoutConfig>(() =>
    loadVelocityCockpitLayout()
  );

  useEffect(() => {
    const handleCustom = (ev: Event) => {
      const detail = (ev as CustomEvent<VelocityCockpitLayoutConfig>).detail;
      if (detail) {
        setConfig(detail);
      } else {
        setConfig(loadVelocityCockpitLayout());
      }
    };
    const handleStorage = (ev: StorageEvent) => {
      if (ev.key === VELOCITY_COCKPIT_LAYOUT_KEY) {
        setConfig(loadVelocityCockpitLayout());
      }
    };
    window.addEventListener(VELOCITY_COCKPIT_LAYOUT_EVENT, handleCustom);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(VELOCITY_COCKPIT_LAYOUT_EVENT, handleCustom);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const setLayoutId = useCallback((layoutId: VelocityCockpitLayoutId) => {
    setConfig((prev) => {
      const next: VelocityCockpitLayoutConfig = { ...prev, layoutId };
      saveVelocityCockpitLayout(next);
      return next;
    });
  }, []);

  const setMenuPosition = useCallback((menuPosition: VelocityMenuPosition) => {
    setConfig((prev) => {
      const next: VelocityCockpitLayoutConfig = { ...prev, menuPosition };
      saveVelocityCockpitLayout(next);
      return next;
    });
  }, []);

  const updateCustomWidgets = useCallback(
    (updater: (prev: CustomWidgetConfig[]) => CustomWidgetConfig[]) => {
      setConfig((prev) => {
        const next: VelocityCockpitLayoutConfig = {
          ...prev,
          customWidgets: updater(prev.customWidgets),
        };
        saveVelocityCockpitLayout(next);
        return next;
      });
    },
    []
  );

  const resetCustomWidgets = useCallback(() => {
    setConfig((prev) => {
      const next: VelocityCockpitLayoutConfig = {
        ...prev,
        customWidgets: getDefaultCustomWidgets(),
      };
      saveVelocityCockpitLayout(next);
      return next;
    });
  }, []);

  return {
    config,
    preset: getPresetMeta(config.layoutId),
    setLayoutId,
    setMenuPosition,
    updateCustomWidgets,
    resetCustomWidgets,
  };
}
