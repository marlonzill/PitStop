import React, { useState } from 'react';
import { Eye, EyeOff, Lock, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { authenticateUnifiedAdmin } from '../services/deviceLicenseService';

interface AdminSecretLoginModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const AdminSecretLoginModal: React.FC<AdminSecretLoginModalProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = authenticateUnifiedAdmin(username, password);
      if (!session) {
        setError('Usuário ou senha inválidos.');
        return;
      }
      setUsername('');
      setPassword('');
      onSuccess();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-secret-modal-title"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xs rounded-2xl border border-[var(--ps-border-strong)] bg-[var(--ps-surface)] p-4 text-[var(--ps-text)] shadow-2xl space-y-3.5"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-500/40 bg-cyan-500/15 text-cyan-400">
              <Lock className="h-4 w-4" />
            </div>
            <h2
              id="admin-secret-modal-title"
              className="truncate font-['Barlow_Condensed'] text-lg font-extrabold tracking-wide text-[var(--ps-text)] uppercase"
            >
              Acesso Admin
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--ps-border)] bg-[var(--ps-card-deep)] text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-2.5">
          <label className="block space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
              Usuário
            </span>
            <input
              type="text"
              required
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Usuário admin"
              className="min-h-[40px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] px-3 text-xs font-semibold text-[var(--ps-text)] focus:border-cyan-400 focus:outline-none"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[10px] font-bold tracking-wider text-[var(--ps-muted)] uppercase">
              Senha
            </span>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Senha"
                className="min-h-[40px] w-full rounded-lg border border-[var(--ps-border-strong)] bg-[var(--ps-card-deep)] pr-9 pl-3 text-xs font-semibold text-[var(--ps-text)] focus:border-cyan-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute top-1/2 right-2 -translate-y-1/2 p-1 text-[var(--ps-muted)] hover:text-[var(--ps-text)]"
                aria-label="Mostrar ou ocultar senha"
              >
                {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </label>

          {error && (
            <div className="rounded-lg border border-red-500/45 bg-red-950/40 px-2.5 py-1.5 text-[11px] font-semibold text-red-200">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="pitstop-btn-red flex min-h-[42px] w-full items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-extrabold tracking-wider uppercase disabled:opacity-60"
          >
            {submitting ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            <span>Liberar Painel</span>
          </button>
        </form>
      </div>
    </div>
  );
};
