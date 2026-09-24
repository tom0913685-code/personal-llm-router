// @article topic:api-key-layer
// 修 code review 抓到的 TOCTOU 競態：requireGatewayKey 檢查完額度到
// chat.routes.ts 真正呼叫 incrementSpend() 之間隔著一次上游呼叫
// （await adapter.chat()），同一把 key 若在這段空窗期又有其他請求進來，
// 會各自看到「更新前」的 current_spend 一起通過檢查，加總後可能遠超過
// budget_limit。這裡提供一個依 key 排隊的最小 mutex：同一把 key 的下一
// 個任務要等前一個任務完全 settle 才會開始，不同 key 之間互不影響。
//
// Map 的大小只跟「同時有掛著任務的 key 數」成正比，不是跟請求量成正比
// （同一個 key 的多次呼叫共用同一個 entry，只是往後鏈接），個人單機使用
// 的 key 數量很小，不需要額外做過期清除。
const tails = new Map<string, Promise<unknown>>();

export function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previousTail = tails.get(key) ?? Promise.resolve();
  const result = previousTail.then(task, task);
  // 存進 Map 的 tail 永遠不能是 rejected 的 promise，否則下一個排隊的呼叫
  // 會被前一個呼叫的失敗卡住——這裡吞掉錯誤只是為了不阻塞佇列，呼叫端拿
  // 到的 `result` 仍然是自己那筆任務真正的成功/失敗結果，不受影響。
  tails.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
