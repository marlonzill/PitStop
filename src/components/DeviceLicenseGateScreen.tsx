import React, { useRef, useState } from 'react';
import {
  Check,
  Copy,
  Lock,
  RefreshCw,
  ShieldAlert,
  Smartphone,
} from 'lucide-react';
import { AdminSecretLoginModal } from './AdminSecretLoginModal';
import { PitStopLogo } from './PitStopLogo';
import { type DeviceLicenseStatus } from '../services/deviceLicenseService';

interface DeviceLicenseGateScreenProps {
  license: DeviceLicenseStatus;
  checking: boolean;
  onRetry: () => void;
  onAdminUnlocked?: () => void;
}

export const DeviceLicenseGateScreen: React.FC<DeviceLicenseGateScreenProps> = ({
  license,
  checking,
  onRetry,
  onAdminUnlocked,
}) => {
  const [copied, setCopied] = useState(false);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<number | null>(null);

  const handleSecretTap = () => {
    tapCountRef.current += 1;
    if (tapTimerRef.current !== null) {
      window.clearTimeout(tapTimerRef.current);
    }
    if (tapCountRef.current >= 5) {
      tapCountRef.current = 0;
      tapTimerRef.current = null;
      setAdminModalOpen(true);
      return;
    }
    tapTimerRef.current = window.setTimeout(() => {
      tapCountRef.current = 0;
      tapTimerRef.current = null;
    }, 2500);
  };

  const handleCopyDeviceId = async () => {
    const id = license.identity.deviceId;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(id);
      } else {
        const ta = document.createElement('textarea');
        ta.value = id;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Ignore clipboard failures
    }
  };

  const reasonDescription =
    license.reason === 'expired'
      ? `O período de uso deste aparelho expirou${
          license.expiresAt
            ? ` em ${new Date(license.expiresAt).toLocaleDateString('pt-BR')}`
            : ''
        }. Envie o ID de 5 dígitos abaixo para liberação.`
      : license.reason === 'offline_expired'
        ? 'Este aparelho está há mais de 7 dias sem verificação online. Conecte-se à internet e toque em "Verificar Liberação".'
        : 'Este aparelho foi bloqueado ou aguarda liberação. Envie o ID de 5 dígitos abaixo para liberar o acesso.';

  return (
    <div className="flex min-h-[100dvh] w-full flex-col items-center justify-center bg-rally-asphalt px-4 py-8 text-[var(--ps-text)]">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-5 shadow-2xl sm:p-6">
        <div className="flex flex-col items-center text-center space-y-3">
          <PitStopLogo variant="full" className="h-10 w-auto" />

          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-red-500/40 bg-red-500/15 text-[#FF2A2A]">
            {license.reason === 'expired' ? (
              <ShieldAlert className="h-6 w-6" />
            ) : (
              <Lock className="h-6 w-6" />
            )}
          </div>

          <div className="space-y-1.5">
            <h1 className="font-['Barlow_Condensed'] text-2xl font-black tracking-wide text-[var(--ps-text)] uppercase leading-tight">
              Licença Expirada ou Aguardando Liberação
            </h1>
            <p className="text-xs leading-relaxed text-[var(--ps-muted)]">
              {reasonDescription}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] p-4 space-y-2.5">
          <div className="flex items-center justify-between text-[11px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
            <span className="inline-flex items-center gap-1.5">
              <Smartphone className="h-3.5 w-3.5 text-[var(--ps-accent)]" />
              <span>ID do Aparelho</span>
            </span>
            <button
              type="button"
              onClick={handleSecretTap}
              className="font-mono text-[10px] tabular-nums text-[var(--ps-muted)] select-none"
            >
              {license.identity.appVersion}
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ps-border)] bg-[var(--ps-surface)] px-3 py-2.5">
            <span className="font-mono text-2xl font-black tracking-widest text-[var(--ps-amber)] tabular-nums select-all">
              {license.identity.deviceId}
            </span>
            <button
              type="button"
              onClick={() => {
                void handleCopyDeviceId();
              }}
              className={`inline-flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-extrabold transition ${
                copied
                  ? 'bg-emerald-600 text-white'
                  : 'border border-[var(--ps-border-strong)] bg-[var(--ps-card)] text-[var(--ps-text)] hover:border-[var(--ps-accent)]'
              }`}
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  <span>Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copiar ID</span>
                </>
              )}
            </button>
          </div>

          <button
            type="button"
            onClick={handleSecretTap}
            className="w-full truncate text-left font-mono text-[10px] text-[var(--ps-muted)] select-none"
          >
            {license.identity.deviceModel} · {license.identity.appVersion}
            {license.pilotName ? ` · Piloto: ${license.pilotName}` : ''}
          </button>
        </div>

        {license.syncError && (
          <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-center text-[11px] text-[var(--ps-amber)]">
            Última tentativa de sincronização: {license.syncError}
          </p>
        )}

        <button
          type="button"
          onClick={onRetry}
          disabled={checking}
          className="pitstop-btn-red flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-black tracking-wider uppercase disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
          <span>{checking ? 'Verificando...' : 'Verificar Liberação'}</span>
        </button>

        <p
          onClick={handleSecretTap}
          className="pt-1 text-center text-[10px] tracking-wide text-[var(--ps-muted)] select-none"
        >
          Desenvolvido por Márlon Zill · PitStop-Sports
        </p>
      </div>

      <AdminSecretLoginModal
        open={adminModalOpen}
        onClose={() => setAdminModalOpen(false)}
        onSuccess={() => {
          setAdminModalOpen(false);
          if (onAdminUnlocked) {
            onAdminUnlocked();
          } else {
            onRetry();
          }
        }}
      />
    </div>
  );
};
