import type { ReactNode } from 'react';
import Link from 'next/link';

// 純靜態說明頁面，不打任何 API——內容跟 MCP 的 get_integration_guide 工具
// 目的一致（讓人/agent 快速了解這個服務在幹嘛、怎麼用），差別是這頁給的
// 是「人」看的，MCP 那個是給「AI agent」用的，兩邊各自維護各自的用詞，
// 不用勉強共用同一份文字（前端這邊可以放連結/排版，MCP 只能回純文字）。
// 見 docs/requirements/07-mcp-server.md。

const MCP_TOOLS: { name: string; description: string; kind: '查詢' | '管理' }[] = [
  { name: 'get_integration_guide', description: '回傳這個 service 的用途說明、baseURL／認證方式，以及目前可用的 model 清單', kind: '查詢' },
  { name: 'list_models', description: '列出目前啟用中的 public model 名稱', kind: '查詢' },
  { name: 'list_deployments', description: '完整 Deployment 清單（priority、健康度、定價、排程檢查設定）', kind: '查詢' },
  { name: 'list_credentials', description: 'Credential 清單（不含 api key 明文）', kind: '查詢' },
  { name: 'get_usage_summary', description: '花費/請求數/錯誤率/Fallback 觸發率彙總', kind: '查詢' },
  { name: 'search_logs', description: '請求明細查詢，可依時間/model/deployment/狀態篩選', kind: '查詢' },
  { name: 'create_credential', description: '新增一組上游 provider 的連線設定', kind: '管理' },
  { name: 'update_credential', description: '編輯既有 Credential（含啟用/停用）', kind: '管理' },
  { name: 'create_deployment', description: '把一個 Credential 底下的 model 掛成一個 public model 名稱', kind: '管理' },
  { name: 'update_deployment', description: '編輯既有 Deployment（含啟用/停用、調整 priority）', kind: '管理' },
  { name: 'trigger_health_check', description: '對指定 Deployment 立即送一次真的 model 檢查', kind: '管理' },
];

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-surface p-3 text-[12px] leading-relaxed text-text">
      <code className="font-mono">{children}</code>
    </pre>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-card-border bg-white shadow-sm p-5">
      <h2 className="text-[14px] font-semibold text-text mb-3">{title}</h2>
      <div className="space-y-3 text-[13px] text-text-muted leading-relaxed">{children}</div>
    </section>
  );
}

export default function AboutPage() {
  return (
    <div className="space-y-6">
      <Section title="這是什麼">
        <p>
          個人版 LLM Router 把多個 LLM provider（OpenAI 相容 API、Anthropic 原生 API 等）統一包成同一組
          OpenAI 相容的 <code className="font-mono text-text">/v1/chat/completions</code> 介面。你在 Models
          頁面設定的每個 Deployment 可以指定 priority，同一個 public model 名稱底下若有多筆候選，主要的失敗時會自動改打次要的（Fallback），呼叫端只需要認得一個穩定的 model
          名稱，不用關心背後實際是哪個 provider 在服務。
        </p>
      </Section>

      <Section title="怎麼呼叫">
        <p>
          先到{' '}
          <Link href="/api-keys" className="text-primary hover:underline">
            API Keys
          </Link>{' '}
          頁面申請一把 key（明文只會顯示一次，請立即複製），然後：
        </p>
        <CodeBlock>{`curl {你的 Gateway 網址}/v1/chat/completions \\
  -H "Authorization: Bearer <你的 API Key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "<public model 名稱，見 Models 頁面>",
    "messages": [{ "role": "user", "content": "hello" }]
  }'`}</CodeBlock>
        <p>
          Body 格式跟 OpenAI Chat Completions API 相容。本機開發預設 Gateway 網址是{' '}
          <code className="font-mono text-text">http://localhost:8787</code>，部署到其他地方時換成實際位址即可。
        </p>
      </Section>

      <Section title="MCP 功能">
        <p>
          這個服務也提供官方 <code className="font-mono text-text">@modelcontextprotocol/sdk</code> 實作的 MCP
          server，讓 Claude Code、Claude Desktop 等 MCP client 接上後能直接查詢/管理這個 router，不用另外去讀文件或記
          REST API 的網址跟格式。傳輸方式是 stdio（當本機 subprocess 跑，不開 network port），需要 Gateway 後端（
          <code className="font-mono text-text">npm run start</code>）已經在跑。
        </p>
        <p>
          啟動方式：<code className="font-mono text-text">npm run mcp</code>，需要 <code className="font-mono text-text">SITE_SESSION_SECRET</code>
          （跟後端共用，用來自己簽發合法的管理權限 token）跟選填的 <code className="font-mono text-text">BACKEND_URL</code>
          （沒設定時預設 <code className="font-mono text-text">http://localhost:8787</code>）。

        </p>

        <table className="w-full text-[13px] mt-2">
          <thead>
            <tr className="border-b border-card-border text-left text-text-small">
              <th className="py-2 pr-3 font-medium">工具</th>
              <th className="py-2 pr-3 font-medium">類型</th>
              <th className="py-2 font-medium">說明</th>
            </tr>
          </thead>
          <tbody>
            {MCP_TOOLS.map((tool) => (
              <tr key={tool.name} className="border-b border-card-border last:border-0">
                <td className="py-2 pr-3 font-mono text-text whitespace-nowrap">{tool.name}</td>
                <td className="py-2 pr-3 text-text-muted whitespace-nowrap">{tool.kind}</td>
                <td className="py-2 text-text-muted">{tool.description}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="text-text-small">
          API Keys（額度上限、模型權限等）刻意只能透過 Web UI 操作，MCP 沒有對應的管理工具——降低 AI agent
          自己開通更多存取權限的風險面。
        </p>
      </Section>
    </div>
  );
}
