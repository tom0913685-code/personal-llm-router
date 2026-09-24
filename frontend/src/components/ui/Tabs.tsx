import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';

export function Tabs({
  value,
  onValueChange,
  tabs,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: string }[];
  children: ReactNode;
}) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange}>
      <RadixTabs.List className="flex gap-1 border-b border-shell mb-4">
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.value}
            value={tab.value}
            className="px-3 py-2 text-[13px] font-medium text-text-muted border-b-2 border-transparent transition-colors hover:text-text data-[state=active]:text-primary data-[state=active]:border-primary"
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

export const TabPanel = RadixTabs.Content;
