import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Clock, Delete, X } from 'lucide-react';

interface StartTimeCalculatorModalProps {
  open: boolean;
  stageName: string;
  initialTimeStr: string;
  clockOffsetMs: number;
  onConfirm: (hhMmSs: string) => void;
  onSkip?: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  skipLabel?: string;
}

export function parseStartTimeClock(
  raw: string
): { hh: number; mm: number; ss: number } | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] !== undefined ? Number(m[3]) : 0;
  if (
    !Number.isInteger(hh) ||
    !Number.isInteger(mm) ||
    !Number.isInteger(ss) ||
    hh < 0 ||
    hh > 23 ||
    mm < 0 ||
    mm > 59 ||
    ss < 0 ||
    ss > 59
  ) {
    return null;
  }
  return { hh, mm, ss };
}

export function formatStartTimeClock(hh: number, mm: number, ss: number): string {
  return [
    String(hh).padStart(2, '0'),
    String(mm).padStart(2, '0'),
    String(ss).padStart(2, '0'),
  ].join(':');
}

function clockToDigits(raw: string): string {
  const parsed = parseStartTimeClock(raw);
  if (!parsed) return '';
  return [
    String(parsed.hh).padStart(2, '0'),
    String(parsed.mm).padStart(2, '0'),
    String(parsed.ss).padStart(2, '0'),
  ].join('');
}

function formatClockHhMmSs(tsMs: number): string {
  const d = new Date(tsMs);
  return formatStartTimeClock(d.getHours(), d.getMinutes(), d.getSeconds());
}

export const StartTimeCalculatorModal: React.FC<StartTimeCalculatorModalProps> = ({
  open,
  stageName,
  initialTimeStr,
  clockOffsetMs,
  onConfirm,
  onSkip,
  onCancel,
  confirmLabel = 'Confirmar Horário',
  skipLabel = 'Sem Horário / Pular',
}) => {
  const [digits, setDigits] = useState<string>('');
  const [replaceOnFirstDigit, setReplaceOnFirstDigit] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!open) return;
    const initialDigits = clockToDigits(initialTimeStr);
    setDigits(initialDigits);
    setReplaceOnFirstDigit(initialDigits.length > 0);
    setErrorMsg(null);
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [open, initialTimeStr]);

  const adjustedNowMs = nowMs + clockOffsetMs;

  const trimmedStage = stageName.trim() || 'Especial';
  const ssHeading = /^SS\b/i.test(trimmedStage) ? trimmedStage : `SS - ${trimmedStage}`;

  const resolveValidatedTime = (digitStr: string): string | null => {
    if (digitStr.length < 4) return null;
    const padded = digitStr.padEnd(6, '0');
    const hh = Number(padded.slice(0, 2));
    const mm = Number(padded.slice(2, 4));
    const ss = Number(padded.slice(4, 6));
    if (hh > 23 || mm > 59 || ss > 59) return null;
    return formatStartTimeClock(hh, mm, ss);
  };

  const pressDigit = (d: string) => {
    setErrorMsg(null);
    setDigits((prev) => {
      const base = replaceOnFirstDigit ? '' : prev;
      if (base.length >= 6) return base;
      const next = `${base}${d}`;
      if (next.length >= 2 && Number(next.slice(0, 2)) > 23) {
        setErrorMsg('Hora inválida (use 00 a 23)');
        return base;
      }
      if (next.length >= 4 && Number(next.slice(2, 4)) > 59) {
        setErrorMsg('Minutos inválidos (use 00 a 59)');
        return base;
      }
      if (next.length === 6 && Number(next.slice(4, 6)) > 59) {
        setErrorMsg('Segundos inválidos (use 00 a 59)');
        return base;
      }
      return next;
    });
    setReplaceOnFirstDigit(false);
  };

  const pressClear = () => {
    setErrorMsg(null);
    setDigits('');
    setReplaceOnFirstDigit(false);
  };

  const pressBackspace = () => {
    setErrorMsg(null);
    setReplaceOnFirstDigit(false);
    setDigits((prev) => prev.slice(0, -1));
  };

  const shiftBySeconds = (deltaSec: number) => {
    setErrorMsg(null);
    setReplaceOnFirstDigit(false);
    setDigits((prev) => {
      let hh: number;
      let mm: number;
      let ss: number;
      const validExisting = resolveValidatedTime(prev);
      if (validExisting) {
        const parsed = parseStartTimeClock(validExisting)!;
        hh = parsed.hh;
        mm = parsed.mm;
        ss = parsed.ss;
      } else {
        const refDate = new Date(adjustedNowMs);
        hh = refDate.getHours();
        mm = refDate.getMinutes();
        ss = deltaSec >= 60 || deltaSec <= -60 ? 0 : refDate.getSeconds();
      }
      let totalSec = hh * 3600 + mm * 60 + ss + deltaSec;
      totalSec = ((totalSec % 86400) + 86400) % 86400;
      const nHh = Math.floor(totalSec / 3600);
      const nMm = Math.floor((totalSec % 3600) / 60);
      const nSs = totalSec % 60;
      return `${String(nHh).padStart(2, '0')}${String(nMm).padStart(2, '0')}${String(nSs).padStart(2, '0')}`;
    });
  };

  const handleConfirm = () => {
    const resolved = resolveValidatedTime(digits);
    if (!resolved) {
      setErrorMsg('Digite pelo menos HH:MM (4 dígitos) para confirmar');
      return;
    }
    onConfirm(resolved);
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        pressDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        pressBackspace();
      } else if (e.key === 'Delete' || e.key.toLowerCase() === 'c') {
        e.preventDefault();
        pressClear();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (!open) return null;

  const renderSlotPair = (startIdx: number, placeholderChar: string) => {
    const c1 = digits[startIdx];
    const c2 = digits[startIdx + 1];
    const isCursor1 = !replaceOnFirstDigit && digits.length === startIdx;
    const isCursor2 = !replaceOnFirstDigit && digits.length === startIdx + 1;
    return (
      <span className="inline-flex items-center gap-0.5">
        <span
          className={`inline-flex min-w-[0.68em] justify-center rounded-md px-0.5 transition-colors ${
            c1 !== undefined
              ? 'text-[var(--ps-text)]'
              : isCursor1
                ? 'border-b-2 border-[var(--ps-accent)] text-[var(--ps-muted)]/60'
                : 'text-[var(--ps-muted)]/35'
          }`}
        >
          {c1 ?? placeholderChar}
        </span>
        <span
          className={`inline-flex min-w-[0.68em] justify-center rounded-md px-0.5 transition-colors ${
            c2 !== undefined
              ? 'text-[var(--ps-text)]'
              : isCursor2
                ? 'border-b-2 border-[var(--ps-accent)] text-[var(--ps-muted)]/60'
                : 'text-[var(--ps-muted)]/35'
          }`}
        >
          {c2 ?? placeholderChar}
        </span>
      </span>
    );
  };

  const keypadBtnClass =
    'flex h-full min-h-[42px] items-center justify-center rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card)] font-mono text-[clamp(1.25rem,3.4dvh,1.75rem)] font-black text-[var(--ps-text)] shadow-sm transition-transform active:scale-[0.96] hover:border-[var(--ps-border-strong)]';

  const fineTuneBtnClass =
    'flex min-h-[clamp(36px,5dvh,44px)] items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] font-mono text-xs font-extrabold text-[var(--ps-text)] transition-transform active:scale-95 hover:border-[var(--ps-accent)]';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Hora de Largada da Especial"
      className="fixed inset-0 z-[9999] flex h-[100dvh] w-screen items-center justify-center bg-black/75 px-3 pt-[max(10px,env(safe-area-inset-top))] pb-[max(10px,env(safe-area-inset-bottom))] backdrop-blur-md sm:p-4"
    >
      <div className="flex h-full max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-20px)] w-full max-w-md flex-col justify-between gap-[clamp(6px,1.2dvh,12px)] overflow-hidden rounded-2xl border-2 border-[var(--ps-accent)] bg-[var(--ps-surface)] p-[clamp(10px,1.8dvh,16px)] text-[var(--ps-text)] shadow-2xl sm:max-h-[650px]">
        {/* 1. Cabeçalho de Confirmação da Especial */}
        <div className="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] font-extrabold tracking-widest text-[var(--ps-accent)] uppercase">
              Hora de Largada · Cartela
            </p>
            <h2 className="truncate font-['Barlow_Condensed'] text-[clamp(1.15rem,2.9dvh,1.5rem)] font-black tracking-wide text-[var(--ps-text)] uppercase">
              {ssHeading}
            </h2>
          </div>
          <div className="shrink-0 text-right font-mono tabular-nums">
            <p className="text-[9px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
              GPS Oficial
            </p>
            <p className="inline-flex items-center gap-1 text-xs font-extrabold text-[var(--ps-emerald)]">
              <Clock className="h-3 w-3" />
              <span>{formatClockHhMmSs(adjustedNowMs)}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            title="Fechar sem alterar"
            aria-label="Fechar"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-muted)] transition-colors hover:border-[var(--ps-accent)] hover:text-[var(--ps-text)] active:scale-95"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 2. Visor HH : MM : SS */}
        <div className="flex shrink-0 flex-col items-center justify-center rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 py-[clamp(8px,1.6dvh,14px)] text-center shadow-inner">
          <div className="flex items-center justify-center gap-1.5 font-mono text-[clamp(2rem,5.8dvh,3.15rem)] font-black leading-none tracking-tight tabular-nums">
            {renderSlotPair(0, '0')}
            <span className="text-[var(--ps-accent)]">:</span>
            {renderSlotPair(2, '0')}
            <span className="text-[var(--ps-accent)]">:</span>
            {renderSlotPair(4, '0')}
          </div>
          <p
            className={`mt-1.5 min-h-[16px] font-mono text-[11px] font-bold ${
              errorMsg ? 'text-[#FF5252]' : 'text-[var(--ps-muted)]'
            }`}
          >
            {errorMsg
              ? errorMsg
              : digits.length === 4
                ? 'Segundos assumidos como :00 (ou digite SS)'
                : 'Digite HH : MM : SS no teclado'}
          </p>
        </div>

        {/* 3. Ajuste Fino (+1m / -1m / +1s / -1s) */}
        <div className="grid shrink-0 grid-cols-4 gap-1.5">
          <button type="button" onClick={() => shiftBySeconds(-60)} className={fineTuneBtnClass}>
            -1m
          </button>
          <button type="button" onClick={() => shiftBySeconds(-1)} className={fineTuneBtnClass}>
            -1s
          </button>
          <button type="button" onClick={() => shiftBySeconds(1)} className={fineTuneBtnClass}>
            +1s
          </button>
          <button type="button" onClick={() => shiftBySeconds(60)} className={fineTuneBtnClass}>
            +1m
          </button>
        </div>

        {/* 4. Teclado Numérico Estilo Calculadora */}
        <div className="grid min-h-0 flex-1 grid-cols-3 grid-rows-4 gap-[clamp(6px,1dvh,10px)]">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              type="button"
              onClick={() => pressDigit(digit)}
              className={keypadBtnClass}
            >
              {digit}
            </button>
          ))}
          <button
            type="button"
            onClick={pressClear}
            title="Limpar tudo (C)"
            className="flex h-full min-h-[42px] items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] font-mono text-base font-black text-[var(--ps-amber)] shadow-sm transition-transform active:scale-[0.96]"
          >
            C
          </button>
          <button type="button" onClick={() => pressDigit('0')} className={keypadBtnClass}>
            0
          </button>
          <button
            type="button"
            onClick={pressBackspace}
            title="Apagar último dígito"
            aria-label="Apagar"
            className="flex h-full min-h-[42px] items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] shadow-sm transition-transform active:scale-[0.96]"
          >
            <Delete className="h-5 w-5" />
          </button>
        </div>

        {/* 5. Ações Diretas: SEM HORÁRIO / PULAR e CONFIRMAR HORÁRIO */}
        <div className="grid shrink-0 grid-cols-2 gap-2 pt-0.5">
          <button
            type="button"
            onClick={onSkip ?? onCancel}
            className="flex min-h-[clamp(44px,6.2dvh,52px)] items-center justify-center gap-1.5 rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card)] px-2.5 text-center text-[11px] font-black leading-tight tracking-wide text-[var(--ps-text)] uppercase shadow-sm transition-all hover:border-[var(--ps-accent)] active:scale-[0.98] sm:text-xs"
          >
            <X className="h-3.5 w-3.5 shrink-0 text-[var(--ps-muted)] stroke-[2.5]" />
            <span>{skipLabel}</span>
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="flex min-h-[clamp(44px,6.2dvh,52px)] items-center justify-center gap-1.5 rounded-xl bg-[#00C853] px-2.5 text-center text-[11px] font-black leading-tight tracking-wide text-slate-950 uppercase shadow-lg transition-transform hover:bg-[#00b548] active:scale-[0.98] sm:text-xs"
          >
            <Check className="h-4 w-4 shrink-0 stroke-[2.75]" />
            <span>{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
