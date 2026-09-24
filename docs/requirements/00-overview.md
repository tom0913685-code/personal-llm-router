# 個人版 LLM Router — 模組需求文件索引

> 開發順序：Provider Adapter → Gateway 入口 → 請求路由 → Usage/Cost 記錄 → Web UI → 手動健康檢查
> 每份文件都是草稿，請逐一確認「開放問題」段落後再進入設計/實作。

| 模組 | 文件 | 狀態 |
|---|---|---|
| Provider Adapter | [../provider-adapter-spec.md](../provider-adapter-spec.md) | 已定案 |
| 設定/憑證管理 | [01-config-management.md](./01-config-management.md) | 已定案 |
| Gateway/Proxy 入口 | [02-gateway.md](./02-gateway.md) | 已定案 |
| 請求路由/選路邏輯 | [03-routing.md](./03-routing.md) | 已定案 |
| 請求 Log 記錄（含 Usage/Cost） | [04-usage-cost.md](./04-usage-cost.md) | 已定案 |
| 簡易 Web UI | [05-web-ui.md](./05-web-ui.md) | 已定案 |
| Web UI 網站密碼保護 | [06-site-auth.md](./06-site-auth.md) | 已定案 |
| MCP Server | [07-mcp-server.md](./07-mcp-server.md) | 已實作並測試 |
| Gateway API Key 層（取代 ROUTER_API_KEY） | [08-api-key-layer.md](./08-api-key-layer.md) | 已實作並測試 |

## 已定案的共同前提（來自先前討論，各文件不重複贅述）

- 個人單機使用，不做多租戶/Team/跨團隊 Budget
- v1 不支援 streaming、不支援 tool calling（見 provider-adapter-spec.md）
- Web UI 提供完整的 Credential/Deployment/API Key CRUD 表單，不是唯讀檢視

**2026-09-21 修訂**：「健康檢查為手動觸發，不做排程/背景輪詢」這條已經
過時——健康檢查後來拆成兩層（見 `provider-adapter-spec.md`「兩層健康檢
查」），且排程（`auto_health_check_enabled`）目前也會跑真的呼叫 model
的深層檢查，不是原本規劃的純手動。
