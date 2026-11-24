import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface CockpitSelectOption {
  value: string;
  label: string;
  subtitle?: string;
  badge?: string;
}

interface CockpitSelectProps {
  id?: string;
  value: string;
  options: CockpitSelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  compact?: boolean;
  align?: 'left' | 'right';
  triggerClassName?: string;
  menuClassName?: string;
  valueClassName?: string;
  disabled?: boolean;
}

export const CockpitSelect: React.FC<CockpitSelectProps> = ({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Selecionar...',
  compact = false,
  align = 'left',
  triggerClassName = '',
  menuClassName = '',
  valueClassName = '',
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((opt) => opt.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-2 rounded-xl border bg-[var(--ps-card-deep)] px-3 text-left text-[var(--ps-text)] transition-all active:scale-[0.98] disabled:opacity-50 ${
          compact ? 'min-h-[42px] py-1.5' : 'min-h-[48px] py-2'
        } ${
          open
            ? 'border-[var(--ps-accent)] ring-1 ring-[var(--ps-accent)]/40'
            : 'border-[var(--ps-border-strong)] hover:border-[var(--ps-accent)]'
        } ${triggerClassName}`}
      >
        <div className="min-w-0 flex-1">
          <p
            className={`truncate text-xs font-extrabold leading-tight text-[var(--ps-text)] sm:text-sm ${valueClassName}`}
          >
            {selected ? selected.label : placeholder}
          </p>
          {selected?.subtitle && (
            <p className="mt-0.5 truncate font-mono text-[10px] font-bold text-[var(--ps-muted)] uppercase">
              {selected.subtitle}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {selected?.badge && (
            <span className="rounded-md border border-[var(--ps-border)] bg-[var(--ps-surface)] px-1.5 py-0.5 font-mono text-[10px] font-extrabold text-[var(--ps-accent)] uppercase tabular-nums">
              {selected.badge}
            </span>
          )}
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-[var(--ps-muted)] transition-transform ${
              open ? 'rotate-180 text-[var(--ps-accent)]' : ''
            }`}
          />
        </div>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute z-[95] mt-1.5 max-h-64 min-w-full overflow-y-auto rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-1.5 shadow-2xl ${
            align === 'right' ? 'right-0' : 'left-0'
          } ${menuClassName}`}
        >
          {options.length === 0 ? (
            <div className="px-3 py-2.5 text-center text-xs text-[var(--ps-muted)]">
              Nenhuma opção disponível
            </div>
          ) : (
            <div className="space-y-1">
              {options.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className={`flex min-h-[42px] w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-all active:scale-[0.98] ${
                      isSelected
                        ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-text)]'
                        : 'border-transparent text-[var(--ps-text)] hover:bg-[var(--ps-card)]'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-extrabold leading-tight">
                        {opt.label}
                      </p>
                      {opt.subtitle && (
                        <p className="truncate font-mono text-[10px] text-[var(--ps-muted)] uppercase">
                          {opt.subtitle}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {opt.badge && (
                        <span className="rounded border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--ps-accent)] tabular-nums">
                          {opt.badge}
                        </span>
                      )}
                      {isSelected && (
                        <Check className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
