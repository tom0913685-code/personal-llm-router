'use client';

import { useState } from 'react';
import { Tabs, TabPanel } from '../../components/ui/Tabs';
import { CredentialsTab } from '../../components/settings/CredentialsTab';
import { DeploymentsTab } from '../../components/settings/DeploymentsTab';

export default function ModelsPage() {
  // 使用者 2026-09-19 要求：進 /models 預設先看到 Deployments，不是
  // Credentials——Deployment 才是日常會盯的內容（健康度/priority），
  // Credential 是設定一次很少回頭改的東西。
  const [tab, setTab] = useState('deployments');

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      tabs={[
        { value: 'deployments', label: 'Deployments' },
        { value: 'credentials', label: 'Credentials' },
      ]}
    >
      <TabPanel value="deployments">
        <DeploymentsTab />
      </TabPanel>
      <TabPanel value="credentials">
        <CredentialsTab />
      </TabPanel>
    </Tabs>
  );
}
