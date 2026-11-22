import React, { useEffect, useState } from 'react';
import { Clock, Delete, X } from 'lucide-react';

interface TimeCalculatorModalProps {
  open: boolean;
  onClose: () => void;
}

type OpSymbol = '+' | '-' | '×' | '÷';

function digitsToMinutes(digits: string): number {
  if (!digits) return 0;
  const clean = digits.replace(/\D/g, '');
  if (!clean) return 0;
  const padded = clean.padStart(3, '0');
  const mins = parseInt(padded.slice(-2), 10);
  const hours = parseInt(padded.slice(0, -2), 10);
  return hours * 60 + mins;
}

function formatDigitsAsAtmTime(digits: string): string {
  const clean = digits.replace(/\D/g, '');
  if (!clean) return '0:00';
  const padded = clean.padStart(3, '0');
  const mins = padded.slice(-2);
  const hours = String(parseInt(padded.slice(0, -2), 10));
  return `${hours}:${mins}`;
}

function formatMinutesAsTime(totalMinutes: number, clock24hMode: boolean): string {
  const rounded = Math.round(totalMinutes);
  if (clock24hMode) {
    const wrapped = ((rounded % 1440) + 1440) % 1440;
    const h = Math.floor(wrapped / 60);
    const m = wrapped % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}:${String(m).padStart(2, '0')}`;
}

function minutesToCanonicalDigits(totalMinutes: number): string {
  const abs = Math.abs(Math.round(totalMinutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${h}${String(m).padStart(2, '0')}`;
}

interface TimeCalculatorPanelProps {
  onClose?: () => void;
  isModal?: boolean;
  active?: boolean;
}

const TimeCalculatorPanel: React.FC<TimeCalculatorPanelProps> = ({
  onClose,
  isModal = false,
  active = true,
}) => {
  const [rawDigits, setRawDigits] = useState<string>('');
  const [accMinutes, setAccMinutes] = useState<number | null>(null);
  const [pendingOp, setPendingOp] = useState<OpSymbol | null>(null);
  const [historyText, setHistoryText] = useState<string>('');
  const [resultDisplayMinutes, setResultDisplayMinutes] = useState<number | null>(null);
  const [hasTypedAfterOp, setHasTypedAfterOp] = useState<boolean>(false);
  const [clock24hMode, setClock24hMode] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isScalarMode = pendingOp === '×' || pendingOp === '÷';

  const clearAll = () => {
    setRawDigits('');
    setAccMinutes(null);
    setPendingOp(null);
    setHistoryText('');
    setResultDisplayMinutes(null);
    setHasTypedAfterOp(false);
    setErrorMsg(null);
  };

  const applyBinary = (leftMin: number, op: OpSymbol, rightValDigits: string): number | null => {
    if (op === '+') {
      return leftMin + digitsToMinutes(rightValDigits);
    }
    if (op === '-') {
      return leftMin - digitsToMinutes(rightValDigits);
    }
    const factor = parseInt(rightValDigits || '0', 10);
    if (op === '×') {
      return Math.round(leftMin * factor);
    }
    if (op === '÷') {
      if (!factor || factor === 0) {
        setErrorMsg('Divisão por zero');
        return null;
      }
      return Math.round(leftMin / factor);
    }
    return leftMin;
  };

  const pressDigit = (d: string) => {
    setErrorMsg(null);
    setResultDisplayMinutes(null);

    if (d === '00') {
      setRawDigits((prev) => {
        if (!prev) return '';
        if (prev.length >= 7) return prev;
        return `${prev}00`.slice(0, 8);
      });
      setHasTypedAfterOp(true);
      return;
    }

    setRawDigits((prev) => {
      if (prev === '' && d === '0') return '';
      if (prev.length >= 8) return prev;
      return `${prev}${d}`;
    });
    setHasTypedAfterOp(true);
  };

  const pressBackspace = () => {
    setErrorMsg(null);
    if (resultDisplayMinutes !== null) {
      const canonical = minutesToCanonicalDigits(resultDisplayMinutes);
      setResultDisplayMinutes(null);
      setRawDigits(canonical.slice(0, -1));
      setHasTypedAfterOp(true);
      return;
    }
    setRawDigits((prev) => prev.slice(0, -1));
  };

  const pressOperator = (op: OpSymbol) => {
    setErrorMsg(null);

    if (accMinutes !== null && pendingOp !== null && hasTypedAfterOp && rawDigits !== '') {
      const computed = applyBinary(accMinutes, pendingOp, rawDigits);
      if (computed === null) return;
      const leftLabel = formatMinutesAsTime(computed, clock24hMode);
      setAccMinutes(computed);
      setPendingOp(op);
      setHistoryText(`${leftLabel} ${op}`);
      setRawDigits('');
      setHasTypedAfterOp(false);
      setResultDisplayMinutes(computed);
      return;
    }

    let baseMin = accMinutes;
    if (resultDisplayMinutes !== null && !hasTypedAfterOp) {
      baseMin = resultDisplayMinutes;
    } else if (baseMin === null || hasTypedAfterOp) {
      baseMin = digitsToMinutes(rawDigits);
    }

    setAccMinutes(baseMin);
    setPendingOp(op);
    setHistoryText(`${formatMinutesAsTime(baseMin, clock24hMode)} ${op}`);
    setRawDigits('');
    setHasTypedAfterOp(false);
    setResultDisplayMinutes(baseMin);
  };

  const pressEquals = () => {
    setErrorMsg(null);
    if (accMinutes === null || pendingOp === null) {
      if (rawDigits) {
        const val = digitsToMinutes(rawDigits);
        setHistoryText(`${formatDigitsAsAtmTime(rawDigits)} =`);
        setResultDisplayMinutes(val);
        setRawDigits('');
        setHasTypedAfterOp(false);
      }
      return;
    }

    const rightStr =
      hasTypedAfterOp && rawDigits !== ''
        ? rawDigits
        : isScalarMode
          ? '1'
          : '0';

    const computed = applyBinary(accMinutes, pendingOp, rightStr);
    if (computed === null) return;

    const leftText = formatMinutesAsTime(accMinutes, clock24hMode);
    const rightText = isScalarMode
      ? String(parseInt(rightStr || '0', 10))
      : formatDigitsAsAtmTime(rightStr);

    setHistoryText(`${leftText} ${pendingOp} ${rightText} =`);
    setResultDisplayMinutes(computed);
    setAccMinutes(computed);
    setPendingOp(null);
    setRawDigits('');
    setHasTypedAfterOp(false);
  };

  const keyHandlersRef = React.useRef({
    pressDigit,
    pressBackspace,
    pressOperator,
    pressEquals,
    clearAll,
    onClose,
  });
  keyHandlersRef.current = {
    pressDigit,
    pressBackspace,
    pressOperator,
    pressEquals,
    clearAll,
    onClose,
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const h = keyHandlersRef.current;
      if (e.key === 'Escape' && h.onClose) {
        h.onClose();
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        h.pressDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        h.pressBackspace();
      } else if (e.key === '+') {
        e.preventDefault();
        h.pressOperator('+');
      } else if (e.key === '-') {
        e.preventDefault();
        h.pressOperator('-');
      } else if (e.key === '*') {
        e.preventDefault();
        h.pressOperator('×');
      } else if (e.key === '/') {
        e.preventDefault();
        h.pressOperator('÷');
      } else if (e.key === 'Enter' || e.key === '=') {
        e.preventDefault();
        h.pressEquals();
      } else if (e.key.toLowerCase() === 'c') {
        e.preventDefault();
        h.clearAll();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  const mainDisplay = errorMsg
    ? errorMsg
    : hasTypedAfterOp || (resultDisplayMinutes === null && pendingOp === null)
      ? isScalarMode
        ? String(parseInt(rawDigits || '0', 10))
        : formatDigitsAsAtmTime(rawDigits)
      : resultDisplayMinutes !== null
        ? formatMinutesAsTime(resultDisplayMinutes, clock24hMode)
        : '0:00';

  const numBtnClass = isModal
    ? 'min-h-[46px] sm:min-h-[54px] rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card)] text-xl font-extrabold text-[var(--ps-text)] shadow-sm transition-transform active:scale-[0.96]'
    : 'min-h-[54px] sm:min-h-[68px] h-full rounded-xl border border-[var(--ps-border)] bg-[var(--ps-card)] text-2xl sm:text-3xl font-black text-[var(--ps-text)] shadow-sm transition-transform active:scale-[0.96]';
  const opBtnClass = isModal
    ? 'min-h-[46px] sm:min-h-[54px] rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-xl font-extrabold text-[var(--ps-text)] shadow-sm transition-transform active:scale-[0.96]'
    : 'min-h-[54px] sm:min-h-[68px] h-full rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-2xl sm:text-3xl font-black text-[var(--ps-text)] shadow-sm transition-transform active:scale-[0.96]';

  return (
    <div
      className={`w-full overflow-hidden rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-surface)] text-[var(--ps-text)] shadow-xl flex flex-col ${
        isModal ? 'max-w-sm' : 'max-w-lg mx-auto flex-1 min-h-[calc(100dvh-10rem)]'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-3.5 py-2.5 sm:px-4 sm:py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Clock className="h-4 w-4 shrink-0 text-[var(--ps-accent)]" />
          <span className="truncate font-['Barlow_Condensed'] text-lg sm:text-xl font-extrabold tracking-wide uppercase">
            Calculadora de Tempo
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setClock24hMode((v) => !v)}
            className={`rounded-lg border px-2.5 py-1 font-mono text-[10px] sm:text-xs font-bold transition-colors whitespace-nowrap ${
              clock24hMode
                ? 'border-[var(--ps-accent)] bg-[var(--ps-accent-soft)] text-[var(--ps-accent)]'
                : 'border-[var(--ps-border)] bg-[var(--ps-card)] text-[var(--ps-muted)]'
            }`}
            title="Alterna entre total acumulado (>24h) e relógio de 24 horas"
          >
            {clock24hMode ? 'Relógio 24h' : 'Acumulado >24h'}
          </button>

          {isModal && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
              aria-label="Fechar calculadora"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-3 sm:p-4 gap-2.5 sm:gap-3">
        {/* Two-line High-Contrast ATM Display */}
        <div
          className={`rounded-2xl border border-[var(--ps-border)] bg-[var(--ps-card-deep)] px-4 text-right font-mono tabular-nums flex flex-col justify-center ${
            isModal ? 'py-2.5' : 'py-3.5 sm:py-5'
          }`}
        >
          <div className="min-h-[18px] truncate text-xs sm:text-sm font-semibold text-[var(--ps-muted)]">
            {historyText || (isScalarMode ? 'Multiplicador/divisor' : 'Hora:Min')}
          </div>
          <div
            className={`mt-1 truncate font-black tracking-tight ${
              errorMsg
                ? 'text-xl text-red-500'
                : isModal
                  ? 'text-3xl text-[var(--ps-text)] sm:text-4xl'
                  : 'text-4xl text-[var(--ps-text)] sm:text-5xl'
            }`}
          >
            {mainDisplay}
          </div>
        </div>

        {/* Exact 4x5 High-Contrast Keypad Grid */}
        <div className="grid flex-1 grid-cols-4 grid-rows-5 gap-2 font-mono">
          <button
            type="button"
            onClick={clearAll}
            className={`${isModal ? 'min-h-[46px] text-lg' : 'min-h-[54px] sm:min-h-[68px] text-2xl'} h-full rounded-xl border border-amber-500/40 bg-amber-500/15 font-black text-[var(--ps-amber)] transition-transform active:scale-[0.96]`}
          >
            C
          </button>
          <button
            type="button"
            onClick={pressBackspace}
            aria-label="Apagar último dígito"
            className={`flex ${isModal ? 'min-h-[46px]' : 'min-h-[54px] sm:min-h-[68px]'} h-full items-center justify-center rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] text-[var(--ps-text)] transition-transform active:scale-[0.96]`}
          >
            <Delete className={isModal ? 'h-5 w-5' : 'h-6 w-6'} />
          </button>
          <button type="button" onClick={() => pressOperator('÷')} className={opBtnClass}>
            ÷
          </button>
          <button type="button" onClick={() => pressOperator('×')} className={opBtnClass}>
            ×
          </button>

          <button type="button" onClick={() => pressDigit('7')} className={numBtnClass}>
            7
          </button>
          <button type="button" onClick={() => pressDigit('8')} className={numBtnClass}>
            8
          </button>
          <button type="button" onClick={() => pressDigit('9')} className={numBtnClass}>
            9
          </button>
          <button type="button" onClick={() => pressOperator('-')} className={opBtnClass}>
            −
          </button>

          <button type="button" onClick={() => pressDigit('4')} className={numBtnClass}>
            4
          </button>
          <button type="button" onClick={() => pressDigit('5')} className={numBtnClass}>
            5
          </button>
          <button type="button" onClick={() => pressDigit('6')} className={numBtnClass}>
            6
          </button>
          <button
            type="button"
            onClick={() => pressOperator('+')}
            aria-label="Somar horas"
            className={`pitstop-btn-red ${isModal ? 'min-h-[46px] text-2xl' : 'min-h-[54px] sm:min-h-[68px] text-3xl'} h-full rounded-xl font-black transition-transform active:scale-[0.95]`}
          >
            +
          </button>

          <button type="button" onClick={() => pressDigit('1')} className={numBtnClass}>
            1
          </button>
          <button type="button" onClick={() => pressDigit('2')} className={numBtnClass}>
            2
          </button>
          <button type="button" onClick={() => pressDigit('3')} className={numBtnClass}>
            3
          </button>
          <button
            type="button"
            onClick={pressEquals}
            className={`row-span-2 flex h-full items-center justify-center rounded-xl border border-emerald-500/50 bg-emerald-600 ${isModal ? 'text-2xl' : 'text-3xl sm:text-4xl'} font-black text-white shadow-lg transition-transform active:scale-[0.97] hover:bg-emerald-500`}
          >
            =
          </button>

          <button
            type="button"
            onClick={() => pressDigit('0')}
            className={`${numBtnClass} col-span-2`}
          >
            0
          </button>
          <button type="button" onClick={() => pressDigit('00')} className={numBtnClass}>
            00
          </button>
        </div>
      </div>
    </div>
  );
};

export const TimeCalculatorTab: React.FC = () => {
  return (
    <section className="flex w-full flex-col items-stretch justify-center py-0.5 sm:py-2">
      <TimeCalculatorPanel isModal={false} active />
    </section>
  );
};

export const TimeCalculatorModal: React.FC<TimeCalculatorModalProps> = ({ open, onClose }) => {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Calculadora de Tempo"
    >
      <TimeCalculatorPanel isModal active={open} onClose={onClose} />
    </div>
  );
};
