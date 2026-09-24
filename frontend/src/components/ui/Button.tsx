import type { ButtonHTMLAttributes } from 'react';

const VARIANTS = {
  primary: 'bg-primary text-white hover:bg-primary-dark',
  ghost: 'bg-transparent text-text hover:bg-surface',
  danger: 'bg-transparent text-danger border border-danger/30 hover:bg-danger-bg',
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
