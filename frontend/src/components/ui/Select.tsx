import type { SelectHTMLAttributes } from 'react';

// 用原生 <select>，不引入 Radix Select——個人版表單裡的下拉選單選項固定且很
// 少（adapter_type 兩種、log status 兩種），原生元素已經夠用，不需要額外的
// headless primitive 依賴。
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`h-8 w-full rounded border border-shell bg-white px-2 text-[13px] outline-none focus:border-primary ${props.className ?? ''}`}
    />
  );
}
