# Provider Adapter 設計規格（定案版）

> 用途：個人版 LLM Router 開發參考文件，供實作階段（Claude Code / 開發 session）直接依此搭建。
> 本文取代 `~/Downloads/Provider_Adapter設計規格.md` 草稿，修正審閱時發現的 6 個問題後定案。
> 參考另一套正式版 Router 架構調查結果後定案。

## 設計原則

依廠商協議與 OpenAI 格式的相容程度分流，不做「全部透傳」或「全部轉換」的單一策略：

- **透傳型（Passthrough）**：給本身就相容 OpenAI 格式的廠商用（OpenAI、Ollama、vLLM、Gemini 的 OpenAI 相容層）。不寫欄位轉換邏輯,請求/回應直接透傳。新增這類廠商只需要設定資料,不需要新增程式碼。
  - **不支援 Azure OpenAI**（刻意排除）：個人版用不太到，且 Azure 的 URL 結構（`/openai/deployments/{model}/...?api-version=`）與認證方式（`api-key` header）都跟其他 OpenAI-compatible 廠商不同，會讓 `PassthroughAdapter` 多一個條件分支。之後如果真的需要，可以比照下方「新增 Provider 的流程」的原生轉換型模式另外處理，不需要動到現有 passthrough 邏輯。
- **原生轉換型（Native Adapter）**：給協議差異大的廠商用（目前僅 Anthropic）。使用官方 SDK,正確處理 system 欄位位置、認證方式、回應結構等差異,換取原生功能（prompt caching、extended thinking 等）的可用性。

**v1 明確不支援的範圍**（刻意排除,非遺漏）：
- Streaming（`chat()` 為單次 request/response，不吐 SSE）。之後若要加,`ProviderAdapter` 介面需要新增 `chatStream()` 方法或把 `chat()` 改成 async generator，屆時再處理 passthrough 原始 SSE 透傳 vs Anthropic 原生事件轉換的問題。
- Tool use / function calling（`UnifiedChatRequest` 不含 `tools` 欄位）。之後如需要,在共同介面加 `tools?: ToolDefinition[]`，並在兩種 Adapter 內分別做轉換。

## 共同介面

```typescript
export interface UnifiedChatRequest {
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
}

export interface UnifiedChatResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  raw: unknown; // 保留原始回應，供需要存取廠商特有欄位時使用
}

export interface ProviderAdapter {
  chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse>;
  ping(): Promise<{ latencyMs: number }>; // 供健康檢測模組呼叫（手動觸發，非排程）
}
```

## 透傳型 Adapter

```typescript
const REQUEST_TIMEOUT_MS = 30_000;

interface PassthroughConfig {
  baseUrl: string;
  apiKey: string;
}

export class PassthroughAdapter implements ProviderAdapter {
  constructor(private readonly config: PassthroughConfig) {}

  async chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const { baseUrl, apiKey } = this.config;
    const messages = req.system
      ? [{ role: 'system', content: req.system }, ...req.messages]
      : req.messages;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Provider error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    if (!data.choices?.[0]?.message) {
      throw new Error(`Unexpected response shape: ${JSON.stringify(data)}`);
    }

    return {
      content: data.choices[0].message.content,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      raw: data,
    };
  }

  async ping(): Promise<{ latencyMs: number }> {
    const { baseUrl, apiKey } = this.config;
    const start = Date.now();

    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return { latencyMs: Date.now() - start };
  }
}
```

## 原生轉換型 Adapter（Anthropic）

```typescript
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicAdapter implements ProviderAdapter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });
  }

  async chat(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const res = await this.client.messages.create({
      model: req.model,
      system: req.system,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature,
    });

    const textBlock = res.content.find((b) => b.type === 'text');

    return {
      content: textBlock?.type === 'text' ? textBlock.text : '',
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
      raw: res,
    };
  }

  async ping(): Promise<{ latencyMs: number }> {
    // 用 models.list() 而非打一次 chat completion：驗證 API key 有效且可連線，
    // 不綁定特定 model、不燒 token 成本（原草稿用 messages.create 打死 model 名稱，
    // 該 model 若停用或帳號無權限，會誤判 provider 不可用）。
    const start = Date.now();
    await this.client.models.list({ limit: 1 });
    return { latencyMs: Date.now() - start };
  }
}
```

## Adapter Factory

依 provider 設定決定實例化哪一種 Adapter：

```typescript
interface ProviderConfig {
  adapterType: 'passthrough' | 'anthropic_native';
  baseUrl?: string;
  apiKey: string;
}

export function createProviderAdapter(config: ProviderConfig): ProviderAdapter {
  switch (config.adapterType) {
    case 'anthropic_native':
      return new AnthropicAdapter(config.apiKey);
    case 'passthrough':
      if (!config.baseUrl) {
        throw new Error('Passthrough adapter requires baseUrl');
      }
      return new PassthroughAdapter({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });
    default:
      throw new Error(`Unknown adapter type: ${config.adapterType}`);
  }
}
```

## 資料表設計

參考另一套正式版 Router 實際的四層設計（`Provider` → `Credential` → `ModelDeployment` →
`Model` M:N）調查後，個人版採簡化版**兩層**：`Provider` 不建表，收斂成
`adapter_type` 的固定字串值；`Model`／`ModelToDeployment` 的 M:N 加權路由層
（用於 load balancing）v1 不做，直接省略，`credentials` 與
`model_deployments` 一對多即可：

> **修訂（2026-09-14）**：`public_model_name` 原本規劃單獨 UNIQUE（一個
> 名稱只能對應一筆 deployment），後來為了支援 Fallback 改成跟 `priority`
> 的複合唯一索引，讓同一個名稱可以掛多筆 deployment 依序當備援。詳見
> `03-routing.md` 與 `docs/article-notes.md` 的「Fallback」主題。

```
credentials
- id
- name                -- 顯示名稱，如 "OpenAI 個人 key"
- adapter_type        -- 'passthrough' | 'anthropic_native'（未來可擴充新的原生轉換型別）
- base_url            -- 僅 passthrough 需要
- api_key_encrypted   -- AES-256-GCM 加密後的密文（見下方「api_key 加密方案」）
- enabled
- created_at

model_deployments
- id
- credential_id            -- FK -> credentials.id（一組 credential 可掛多個 deployment）
- public_model_name        -- client 呼叫 API 時傳入的 model 名稱
- provider_model_id        -- 實際打給上游 API 的 model 名稱（provider 官方 model id）
- priority                 -- 整數，預設 0，數字小的先試。同一個 public_model_name 可以
                              掛多筆 deployment 依序當 Fallback 候選（見 03-routing.md）
- input_cost_per_million   -- 定價掛在 deployment 層，而非 credential 層：同一組 key 底下
                              不同 model 的價格本來就不同（取代原本規劃的獨立 model_pricing 表，
                              詳見 04-usage-cost.md 的修訂說明）
- output_cost_per_million
- enabled
- auto_health_check_enabled -- 是否排進排程健康檢查的掃描名單，預設 false（見
                              01-config-management.md 的已定案）
- health_status            -- 'unknown' | 'healthy' | 'unhealthy'，手動/排程健康檢查時更新
- last_checked_at
- last_latency_ms
- last_error
- created_at
- updated_at

@@unique([public_model_name, priority])  -- 同一個名稱底下 priority 不能重複，避免
                                             Fallback 順序有歧義
```

**`public_model_name` 與 `provider_model_id` 的轉換**：路由模組
（`03-routing.md`）依 client 傳入的 `model` 查 `public_model_name` 找到對應
`model_deployments` 列，取得 `provider_model_id` 後才呼叫
`ProviderAdapter.chat()`——也就是說傳給 `chat()` 的 `UnifiedChatRequest.model`
欄位，實際上已經是翻譯過的 `provider_model_id`，Adapter 本身不需要知道
client 端看到的名稱。

### api_key 加密方案

個人版單機使用，不需要 KMS，但至少要避免明文落地：

- 一把對稱金鑰存在本機 `.env`（`ENCRYPTION_KEY`，啟動時從環境變數讀取，不進版控）
- 寫入 DB 前用 AES-256-GCM 加密（Node `crypto` 模組原生支援，不需額外套件）
- 讀取時用同一把金鑰解密後再交給 Adapter 使用，解密後的明文只留在記憶體，不落地、不寫 log

## 新增 Provider 的流程

**透傳型廠商**（如 Gemini 的 OpenAI 相容層）：
- `credentials` 表新增一筆資料，`adapter_type: 'passthrough'`，填入對應 base URL
- `model_deployments` 表新增至少一筆，指向這筆 credential
- 不需要新增程式碼

**原生轉換型廠商**（協議差異大，未來若有類似需求，例如之後真的要接 Azure OpenAI）：
- 新增一個實作 `ProviderAdapter` 介面的 class
- 在 Factory 的 switch case 加一個分支
- `credentials` 表新增對應 `adapter_type` 值

## 未來若要加回 load balancing

Fallback（同一個 model 名稱依 priority 依序嘗試多筆 deployment）v1 已經
做了，見 `03-routing.md`。如果之後還想要更進一步的**load balancing**（例如
依權重隨機分流、而非固定依序嘗試），可以參考另一套正式版 Router 的 `Model` 抽象
層 + `ModelToDeployment` M:N join table（含 `weight`）的做法，
`credentials`／`model_deployments` 目前的結構不需要打掉重寫，只是在
`model_deployments` 之上再插一層對應關係。

## 已知限制

- **`ping()` 只驗證「連線＋認證是否正常」，不保證某個 `model_deployment`
  指定的 `provider_model_id` 真的可用**（2026-09-19 更新：這一點原本列
  在這裡當「已知限制、接受這個取捨」，使用者實際建了一個
  `provider_model_id` 打錯的 deployment，健檢卻顯示健康，才發現這個代價
  比預期更大——已經改成兩層健康檢查，見下方新的一節，不再只靠 `ping()`）。
  兩個 Adapter 的 `ping()` 實作都刻意選了「不綁定特定 model」的探測方式
  （Passthrough 打 `/models`，Anthropic 用 `models.list()`），理由是換取
  不燒 token 成本、不會因為某個 model 被停用/帳號無權限就誤判整個
  provider 不可用。`ping()` 現在只用在 Credential 層的「測試連線」，刻意
  不驗證特定 model；Deployment 層（含排程）已經全部改用下面的深層檢查
  （2026-09-21 修訂，見下方）。

## 兩層健康檢查（2026-09-19，2026-09-21 修訂）

`ping()`（連線層）跟真的呼叫 `chat()`（model 層）拆成兩個獨立的檢查，
分開存、分開觸發：

- **Credential 層——連線檢查**：`runCredentialConnectivityCheck()`，就是
  上面說的 `ping()`，寫回 `credentials.connectivity_status`。給 Web UI
  的「測試連線」按鈕用，只驗證「這組 base URL + api_key 能不能連上、認
  證過不過」，目前沒有排程（`credentials` 表沒有對應的 auto-check 開
  關）。
- **Deployment 層——model 檢查**：`runDeploymentModelCheck()`，真的送一
  次最小化的 chat 請求（`messages: [{role:'user', content:'ping'}]`，
  故意不帶 `maxTokens`——見下面的踩坑記錄），用這個 deployment 實際設定
  的 `provider_model_id`，寫回 `model_deployments.health_status`（語意是
  「最近一次檢查」的結果，不分觸發來源）。三個觸發點共用同一套邏輯：
  (1) Web UI 的「手動檢查」按鈕、(2) 新增 deployment 時自動跑一次、
  (3) **排程（`auto_health_check_enabled=true`）**。
- **排程也改用深層檢查了（2026-09-21）**：原本排程刻意只做輕量連線探
  測，避免真的呼叫 model 的持續性 token 成本；使用者要求改成排程也要能
  抓到「model 打錯/不存在」這種問題，不是只能等使用者自己想到要手動
  點。這代表打開 `auto_health_check_enabled` 現在等於接受這個 deployment
  會定期產生真的呼叫 model 的成本，跟輕量 ping 不是同一個成本量級——開
  關本身還是 per-deployment 選擇性啟用，不是全部強制開。
- **`last_manual_checked_at` 欄位**：跟 `last_checked_at`（不分來源、最
  近一次檢查的時間）分開存，只有透過「手動檢查」按鈕觸發時才會更新，讓
  畫面能回答「我自己上次確認是什麼時候」，不會被排程或建立時的自動檢查
  蓋過去。

**踩坑記錄**：第一版把 model 檢查的 `maxTokens` 設成一個很小的值（5）
想省成本，結果直接壞掉——`PassthroughAdapter` 固定送 `max_tokens` 這個
欄位名稱，但新一代 OpenAI 相容 model（包括這個專案主要在用的
`gpt-5.1`）已經改用 `max_completion_tokens`，帶 `max_tokens` 會被上游拒
絕（400 `unsupported_parameter`），把「這個 model 明明正常」誤判成
unhealthy——比原本要修的「假 model 卻顯示 healthy」問題更糟。修法是整個
不帶 `maxTokens`，讓 `JSON.stringify` 直接省略這個欄位，上游用自己的預
設值，兩種參數命名都不會踩到。這是先用真實環境（使用者把服務請求指向
另一個 gateway、真的 `gpt-5.1`）手動驗證才抓到的，光看程式碼邏輯
或只測假上游 server 不會發現這個問題——跟真實 provider 的 API 版本/慣例
對過，才踩得到。
- **`x-request-id` 不是在所有情況下都能對應到一筆 `request_logs`**。
  `02-gateway.md` 原本的措辭（「此請求後續寫入請求 log 時，用同一個
  requestId…讓 client 拿到的 header 值可以直接對到一筆 log 記錄」）沒有
  講清楚例外情況，實際行為分三種：
  1. **驗證失敗在進到 `chatRouter` 之前**（body-parser JSON 解析失敗、
     `requireApiKey` 401）：這兩種情況錯誤發生在 middleware 層，
     `chatRouter` 內設定 `x-request-id` 的那行程式碼根本沒執行到，回應
     完全沒有這個 header，自然也沒有 log 可以對應。
  2. **驗證失敗但已經進到 `chatRouter`**（`stream:true`、`model` 缺
     失、`resolveDeploymentCandidates` 找不到 model、`toUnifiedChatRequest`
     的 body 格式驗證失敗）：header 已經設好、client 拿得到
     `x-request-id`，但**刻意不寫 log**——`src/gateway/chat.routes.ts`
     的註解說明了理由：這幾種都還沒解析出 deployment，沒有
     `deployment_id`／`public_model_name` 這些欄位可以附著，硬寫一筆
     「無 deployment 快照」的 log 反而破壞 `request_logs` 的資料完整性
     假設。
  3. **成功解析路由之後**（呼叫 adapter 成功或失敗）：header 跟
     log 保證一致，這是常態，也是絕大多數請求會走到的路徑。
  這是刻意的設計取捨，不是 bug——`docs/code-review-findings.md` 的低風險
  #23 已經確認過。之後如果真的需要「每個 x-request-id 都查得到東西」，
  做法是在情境 2 也寫一筆 `deployment_id = null` 的 log（schema 本來就允
  許 `deployment_id` 為 null），但目前沒有實際需求驅動這個改動。

## 後續擴充時要回頭處理的事

- Streaming：決定 `chat()` 介面怎麼改（見上方「v1 明確不支援的範圍」）
- Tool use / function calling：`UnifiedChatRequest` 加 `tools` 欄位，兩種 Adapter 分別實作轉換
- Token 用量欄位命名差異（如 `prompt_tokens` vs `input_tokens`）已在各 Adapter 內部正規化，之後新增廠商需比照處理
