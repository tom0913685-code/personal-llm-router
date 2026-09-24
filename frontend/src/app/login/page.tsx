'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';

// 06-site-auth.md 已定案：只有一組共用密碼，沒有帳號概念，密碼錯誤只顯
// 示「密碼錯誤」，不用區分帳號存不存在（本來就沒有帳號）。
export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? '密碼錯誤');
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setError('登入失敗，請稍後再試');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <form onSubmit={handleSubmit} className="w-[320px] space-y-4 rounded border border-card-border bg-white p-6">
        <div>
          <h1 className="text-[16px] font-semibold text-text">個人版 LLM Router</h1>
          <p className="mt-1 text-[12px] text-text-muted">請輸入密碼進入管理後台</p>
        </div>

        <Input
          type="password"
          autoFocus
          placeholder="密碼"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <p className="rounded border border-danger/30 bg-danger-bg px-2.5 py-1.5 text-[12px] text-danger">{error}</p>}

        <Button type="submit" className="w-full" disabled={submitting || !password}>
          {submitting ? '登入中...' : '登入'}
        </Button>
      </form>
    </div>
  );
}
