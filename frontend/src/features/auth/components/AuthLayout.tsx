// 登录/注册页面布局 — 左侧 editorial 大字 + 右侧表单。

import type { ReactNode } from 'react';
import { IconBlock } from '@/components/ui/IconBlock';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@/app/brand';

interface AuthLayoutProps {
  /** 页面标题（如 "登录"、"注册"） */
  title: string;
  /** 副标题 */
  subtitle: string;
  /** 表单内容 */
  children: ReactNode;
}

export function AuthLayout({ title, subtitle, children }: AuthLayoutProps) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr] bg-paper">
      {/* 左侧：editorial 大字（lg+ 显示） */}
      <aside className="hidden lg:flex flex-col justify-between p-12 xl:p-16 border-r border-ink">
        <IconBlock size="xl" tone="brand" className="font-serif text-[28px] font-bold">
          墨
        </IconBlock>

        <div className="fade-up">
          <p className="font-sans text-[11px] text-stone uppercase tracking-[0.24em]">
            {PRODUCT_NAME} · 控制台
          </p>
          <div className="h-px bg-ink mt-3.5 mb-7" />
          <h1 className="font-serif text-[100px] xl:text-[132px] font-black leading-[0.92] text-ink">
            {title}
          </h1>
          <p className="font-serif text-[20px] text-stone mt-7 max-w-md leading-relaxed">
            {subtitle}
          </p>
        </div>

        <span className="font-mono text-[11px] text-stone tracking-[0.06em]">
          400 × 300 · 1bpp · esp32-s3
        </span>
      </aside>

      {/* 右侧：表单 */}
      <main className="flex items-start lg:items-center justify-center px-5 sm:px-8 pt-16 pb-32 lg:py-12">
        <div className="w-full max-w-sm fade-up fade-up-1">
          {/* 移动端 logo */}
          <div className="lg:hidden mb-10 text-center">
            <IconBlock size="xl" tone="brand" className="font-serif text-[28px] font-bold">
              墨
            </IconBlock>
            <h1 className="font-serif text-[36px] font-bold leading-none mt-3 tracking-tight">
              {PRODUCT_NAME}
            </h1>
            <p className="font-sans text-[11px] text-stone mt-2 uppercase tracking-[0.2em]">
              {PRODUCT_TAGLINE}
            </p>
          </div>

          {children}
        </div>
      </main>
    </div>
  );
}
