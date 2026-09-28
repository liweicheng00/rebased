# Rebased Lite 設計規格（MVP）

> 狀態：草案 v0.1（2026-09-28）
> 範圍：只讀的 Git Graph 與 commit 間檔案比較
> 參考實作：本 repo 的 IntelliJ 原始碼（Apache-2.0）

## 1. 目標

Rebased Lite 是一個輕量的桌面 git 檢視工具。它重現 Rebased（IntelliJ）的 commit graph 畫法，並提供任意兩個 commit 之間的檔案比較。

### 1.1 MVP 功能

1. **Git Graph**：顯示所有分支的 commit graph。畫法與 IntelliJ 相同：
   - 長邊截斷（long edge）。
   - IntelliSort（BEK 排序），預設開啟。
   - 依分支著色。
   - 虛擬捲動，沒有筆數上限。
2. **Commit 比較**：
   - 選兩個 commit，列出兩者之間改變的檔案。
   - 點一個檔案，用 Monaco 顯示雙欄或行內 diff。
   - 選一個 commit，與它的第一個 parent 比較。
   - 選一個 commit，與工作目錄比較。

### 1.2 MVP 不做的事

以下項目不在 MVP 內。原因是先驗證核心體驗，再擴大範圍。

- 任何寫入操作：commit、rebase、merge、reset、squash、drop、checkout。
- 收合線性分支（IntelliJ 的 `collapsing/`）。它可以在 v2 加入。
- 三方 merge 工具、完整文字編輯器、全文搜尋。
- 篩選（分支、作者、路徑、日期）。它可以在 v2 加入。
- Orca 整合。

## 2. 架構

```
┌──────────────────────────── Tauri 2 app ────────────────────────────┐
│ Frontend (TypeScript, 系統 WebView)                                   │
│   GraphView (canvas, 虛擬捲動)   CommitTable   ChangesList            │
│   DiffView (Monaco DiffEditor)                                        │
│                 ▲  Tauri commands (JSON)                              │
│ Backend (Rust)  │                                                     │
│   repo::loader   ── git CLI（log / for-each-ref / diff / show）        │
│   graph::{linear, layout, bek, rows, print, color}  ← IntelliJ 移植    │
│   compare::{changes, content}                                         │
└──────────────────────────────────────────────────────────────────────┘
```

- **Backend 用 Rust。** graph 的所有計算都在 backend 完成。frontend 只收到每一列要畫的元素。
- **git 讀取用 git CLI。** 這與 IntelliJ 的做法一致，也會遵守使用者的 git 設定。之後可以把熱點改用 gix，但 MVP 不需要。
- **Frontend 只負責繪圖和互動。** graph 用 `<canvas>` 繪製，只畫可見的列。

## 3. 資料載入

### 3.1 Graph 拓撲（一次載入）

IntelliJ 的做法（`GitLogProvider.readAllHashes`）是先載入全部 commit 的 hash、parents 和時間，再依需要載入細節。Lite 版採用相同的做法：

```
git log HEAD --branches --remotes --tags --date-order \
    --format=%H%x00%P%x00%ct -z
```

- 參數與 IntelliJ 的 `GitLogUtil.LOG_ALL` 加上 `--date-order` 相同。
- 每筆 commit 只存：`oid`（20 bytes）、`parents`（index 陣列）、`commit_time`（i64）。
- commit 用整數 index 表示，不用字串。這是記憶體最省的表示法。

### 3.2 Refs

```
git for-each-ref --format=%(objectname)%00%(refname)%00%(*objectname) refs/heads refs/remotes refs/tags
git symbolic-ref -q HEAD
```

- annotated tag 用 `%(*objectname)` 指向 commit。

### 3.3 Commit 細節（依需要載入）

- 只為可見的列載入 subject、author、date：

  ```
  git log --no-walk --format=... <oid...>
  ```

- 結果放入 LRU cache。

## 4. Graph 演算法（移植自 IntelliJ）

本章每一節都標出原始檔。移植時要逐行對照原始檔。本章只描述行為與常數。

### 4.1 LinearGraph

來源：`platform/vcs-log/graph/.../impl/permanent/PermanentLinearGraphBuilder.java`、`DuplicateParentFixer.java`

- node 依 `--date-order` 的順序編號，`0` 在最上面。
- edge 從 child 指向 parent。parent 的 index 一定比 child 大。
- 重複的 parent 只保留一個。
- 不在已載入集合中的 parent 產生特殊 edge `NOT_LOAD_COMMIT`，例如 shallow clone 的邊界。

### 4.2 Head 與排序

來源：`GraphLayoutBuilder.kt`、`HeadCommitsComparator.java`、`plugins/git4idea/backend/src/log/GitRefManager.kt`（`GitBranchLayoutComparator`）

- head 有兩種：沒有 child 的 node，以及有 ref 指向的 node。
- 每個 head 取它的「代表 ref」。head 依代表 ref 的類型排序，前面的會排在 graph 的左邊：
  1. `ORIGIN_MASTER`（`origin/master` 或 `origin/main`）
  2. `REMOTE_BRANCH`
  3. `MASTER`（`master` 或 `main`）
  4. `LOCAL_BRANCH`
  5. `TAG`
  6. `CURRENT_BRANCH`
  7. `HEAD`
  8. `OTHER`
- 類型相同時，依 ref 名稱排序。
- 沒有 ref 的 head 排在最後，彼此依 node index 排序。

### 4.3 Layout index

來源：`GraphLayoutBuilder.kt`

layout index 決定元素在同一列裡的左右順序。**它不是欄號。**

```
layoutIndex[*] = 0; current = 1
for head in sortedHeads:
  if layoutIndex[head] != 0: continue
  importantHeads.add(head)
  DFS from head:
    on node n:
      first = layoutIndex[n] == 0
      if first: layoutIndex[n] = current
      child = 第一個 layoutIndex == 0 的 parent（依 parent 順序）
      if child == none:
        if first: current++
        回溯
      else: 前往 child
```

- 同一條第一 parent 鏈上的 commit 會拿到相同的 layout index。
- `importantHeads` 和它們的 layout index 用於著色（4.7 節）。

### 4.4 IntelliSort（BEK 排序，預設開啟）

來源：`impl/facade/sort/bek/BekSorter.java`、`BekBranchCreator.java`、`BekBranch.java`、`BekBranchMerger.java`

IntelliJ 的預設值是 `SortType.Bek`（`VcsLogUiPropertiesImpl.kt`）。它的說明是「merge 時，把進入的 commit 直接放在 merge commit 下方」。

**步驟 A：切分 branch（`BekBranchCreator`）**
- 依 `importantHeads` 的順序，從每個未處理的 head 做 DFS。
- 往下走時，由最後一個 parent 往前檢查。一個 parent 要同時符合兩個條件才加入目前的 branch：
  - 它的 layout index 不小於目前的 node。
  - 它沒有「未處理，且 layout index 不大於它」的 child。
- 遇到已處理、而且 layout index 小於起點的 node 時，記錄一筆 edge restriction。

**步驟 B：合併（`BekBranchMerger` + `BekBranch`）**
- 每一輪，每個 branch 從尾端往上切出一段「可插入區段」。以下任一情況會停止切割：
  - 遇到 restriction。
  - 不再是直接的 parent 關係。
  - 相鄰兩個 commit 的時間差超過 `MAX_DELTA_TIME = 3 天`。
  - 區段超過 `MAX_BLOCK_SIZE = 20`，而且時間差超過 `SMALL_DELTA_TIME = 4 小時`。
- 每一輪選「區段第一個 node 的時間戳最小」的 branch，把它的區段反向加入結果。
- 全部 branch 處理完後，把結果反轉，得到新的列順序。

**IntelliSort 關閉時**，列順序就是 `--date-order` 的順序。

### 4.5 每一列的元素

來源：`impl/print/EdgesInRowGenerator.java`、`impl/print/PrintElementGeneratorImpl.kt`

第 `r` 列有兩種元素：

1. 第 `r` 列的 node。
2. 穿過第 `r` 列的可見 edge，也就是 `up < r < down`，而且符合 4.6 節的可見性規則。另外加上相鄰列的特殊 edge。

- **計算穿過的 edge：** 以 40 列為一個區塊，從最近的區塊邊界逐列增量計算（`BLOCK_SIZE = 40`，`WALK_SIZE = 1000`）。
- **排序：** 用 `GraphElementComparatorByLayoutIndex` 排序。**元素的欄位置就是它在排序後清單中的 index。**
- **比較規則：**
  - edge 對 node 時，取 edge 兩端 layout index 的較大值，和 node 的 layout index 比較。兩者相等時，比較 edge 的 `up` 和 node index。
  - edge 對 edge 時，轉換成「edge 對另一條 edge 的端點 node」再比較。
- **快取：** 每列的結果放入 LRU cache，大小 100。

### 4.6 長邊截斷

來源：`PrintElementGeneratorImpl.kt`

| 常數 | 預設（`showLongEdges = false`） | 顯示長邊（`showLongEdges = true`） |
|---|---|---|
| `longEdgeSize` | 30 | 1000 |
| `visiblePartSize` | 1 | 250 |
| `edgeWithArrowSize` | ∞ | 30 |

設 `size = down - up`、`upOffset = r - up`、`downOffset = down - r`。

- **可見性：** `size < longEdgeSize`，或 `min(upOffset, downOffset) <= visiblePartSize`。
- **箭頭：**
  - `size >= longEdgeSize` 時，在 `upOffset == visiblePartSize` 那一列畫向下箭頭，在 `downOffset == visiblePartSize` 那一列畫向上箭頭。
  - `size >= edgeWithArrowSize` 時，在 `upOffset == 1` 畫向下箭頭，在 `downOffset == 1` 畫向上箭頭。
- **結果：** 預設設定下，跨越 30 列以上的 edge 只在兩端各露出一小段，並帶箭頭，中間完全不畫。這是 IntelliJ graph 看起來乾淨的主要原因。

### 4.7 繪製元素

來源：`PrintElementGeneratorImpl.getPrintElements`

每一列輸出一組元素，node 最後輸出，所以會蓋在 edge 上面：

| 元素 | 欄位 | 繪製方式 |
|---|---|---|
| `Node` | `row, pos, color` | 在 `pos` 欄畫圓點 |
| `Edge` | `row, pos, toPos, dir(UP/DOWN), color, arrow` | 從本列中心的 `pos` 畫到相鄰列邊界的 `toPos`。每條 edge 在每一列畫上、下兩個半段 |
| `TerminalEdge` | `row, pos, dir, color` | 長邊截斷處的短箭頭 |

`toPos` 的算法：在相鄰列的排序清單中找同一條 edge。找不到時，找該 edge 的端點 node。

### 4.8 著色

來源：`impl/print/GraphColorGetterByHead.kt`、`GraphLayoutImpl.getOneOfHeadNodeIndex`、`platform/vcs-log/impl/.../GraphColorManagerImpl`

- **找 head：** 對 node `n`，用二分搜尋在 `importantHeads` 的 layout index 中，找出 layout index 不大於 `layoutIndex[n]` 的最後一個 head。
- **決定顏色：**
  - `layoutIndex[n] == layoutIndex[head]` 時，顏色鍵是 head 代表 ref 的名稱雜湊。所以主線永遠是同一個顏色。
  - 其他情況，顏色鍵是 `layoutIndex[n]`，這是 fragment 的顏色。
  - head 沒有 ref 時，顏色鍵是 0。
- **調色盤：** 顏色鍵取模後對應到固定的調色盤。調色盤由 frontend 決定，要支援亮色和暗色主題。

### 4.9 Graph 寬度

來源：`calculateRecommendedWidth`

- 取前 20,000 列取樣，計算每列寬度的加權平均加一個標準差（`K = 0.1`）。
- 結果用來決定 graph 欄的預設寬度。

## 5. 虛擬捲動與效能

- **backend 一次算好的部分：** LinearGraph、layout index、BEK 列順序。之後只保留整數陣列。
- **backend 依需要計算的部分：** 每列的繪製元素，由 `get_rows(start, end)` 回傳，並使用 4.5 節的快取。
- **frontend：**
  - 只畫視窗內的列，上下各多畫 50 列。
  - 捲動時分批要資料。
- **重新整理：** refs 或 HEAD 改變時，重新載入拓撲。MVP 不做增量更新。

## 6. Commit 比較

來源：`platform/vcs-log/impl/.../ui/actions/CompareRevisionsFromLogAction.kt`

### 6.1 選取與方向

| 選取方式 | 左側（舊） | 右側（新） |
|---|---|---|
| 兩個 commit | 列表中較下方的 commit（`commits[1]`） | 較上方的 commit（`commits[0]`） |
| 一個 commit | 它的第一個 parent。沒有 parent 時用空樹 | 該 commit |
| 一個 commit，比較工作目錄 | 該 commit | 工作目錄的檔案 |

- 兩個 commit 的方向與 IntelliJ 相同，以畫面上的上下位置為準。
- 使用者可以按「交換」切換左右。

### 6.2 變更檔案清單

```
git diff --name-status -M -C -z <left> <right>
git diff --name-status -M -C -z <left>                # 與工作目錄比較
```

- 支援 `A`、`M`、`D`、`R`（改名）、`C`（複製），並列出舊路徑。
- 清單可以切換成平面檢視或目錄樹。

### 6.3 檔案內容與 diff

- 讀取內容：`git show <rev>:<path>`。工作目錄的檔案直接讀磁碟。
- 顯示：Monaco `createDiffEditor`，支援雙欄與行內兩種模式（`renderSideBySide`）。
- 不顯示文字 diff 的情況：
  - 二進位檔（含 NUL byte），只顯示「二進位檔已變更」。
  - 超過 5 MB 的檔案，先顯示提示，使用者確認後才載入。這個門檻值是暫定的。
- 語法上色：用 Monaco 載入 VS Code 的 TextMate 語法（`vscode-textmate` + `vscode-oniguruma`）。這樣上色結果會和 Rebased 相同。

## 7. Backend 介面（Tauri commands）

```ts
open_repo(path: string): RepoInfo
load_graph(opts: { intelliSort: boolean; showLongEdges: boolean }): { rowCount: number; recommendedWidth: number }
get_rows(start: number, end: number): Row[]          // 每列：oid、refs、繪製元素
get_commit_details(oids: string[]): CommitDetails[]
list_changes(left: Rev, right: Rev | "WORKTREE"): Change[]
get_file_pair(left: Rev, right: Rev | "WORKTREE", change: Change): { left?: Blob; right?: Blob }
```

`Row` 的繪製元素使用 4.7 節的三種型別。

## 8. 驗收與測試

### 8.1 演算法一致性（最重要）

- IntelliJ 在 `platform/vcs-log/graph/testData/` 有 88 個 golden test 檔：
  - `elementGenerator/longEdges_*`
  - `layoutBuilder/headsOrder_*`
  - `edgesInRow/*`
  - `graphBuilder/*`
- 把這些測試資料和解析器移植成 Rust 測試。**Rust 版的輸出必須和所有 golden 檔一致。**
- BEK 排序移植 `test/.../linearBek/BekTest.kt` 的案例。

### 8.2 功能驗收

- 開啟 git/git（約 8.6 萬個 commit）後，可以從頭捲到尾，沒有筆數上限。
- 跨越 30 列以上的 edge 在中間不顯示，兩端有箭頭。
- 同一個 repo 在 Rebased 和 Lite 版的 graph 截圖，前 200 列的形狀相同。這項用人工比對。
- 選兩個 commit，變更檔案清單與 `git diff --name-status -M <舊> <新>` 相同。
- 改名的檔案顯示新舊路徑，diff 正確配對。

### 8.3 資源量測

- 用與 Rebased 相同的量測方法，量測 RSS 和啟動時間，並和 Rebased 的量測值比較。量測方法見先前的量測腳本。
- MVP 不設數字目標。先量測，再決定目標。

## 9. 授權

- 第 4 章的演算法是翻譯自 IntelliJ Community 的程式碼（Apache-2.0）。
- 移植的檔案要保留原始版權聲明，並在 `NOTICE` 註明來源。
- Monaco、vscode-textmate 是 MIT。vscode-oniguruma 的 WASM 內含 Oniguruma，是 BSD-2-Clause。

## 10. 未決事項

1. **專案位置。** 獨立 repo，或本 repo 的子目錄。建議用獨立 repo。
2. **MVP 要不要支援多個 repo 分頁。** 建議先只支援一個 repo。
3. **Graph 右側的 commit 表格欄位。** 預設建議 subject、author、date、refs。
4. **大檔案門檻。** 6.3 節的 5 MB 是暫定值。

## 11. 實作狀態（v0.2，2026-09-28）

程式碼在 `rebased-lite/`。

| 規格章節 | 狀態 |
|---|---|
| 3 資料載入 | 完成。commit 細節依可見列分批載入，並快取。 |
| 4.1–4.8 Graph 演算法 | 完成。IntelliJ 的 golden test 全部通過（graphBuilder、layoutBuilder、edgesInRow、elementGenerator、BEK）。 |
| 4.9 Graph 寬度 | 完成。 |
| 5 虛擬捲動 | 完成。git/git（85,787 個 commit）可以捲到任何位置。 |
| 6 Commit 比較 | 完成：單一 commit 對第一個 parent、兩個 commit、commit 對工作目錄、交換左右、雙欄與行內 diff。 |
| 6.3 TextMate 上色 | **未完成。** 目前使用 Monaco 內建的 Monarch 語法。改用 TextMate 語法是下一步。 |
| 8.1 演算法一致性 | 完成（見 4.1–4.8）。 |
| 完整介面（v0.2） | 完成：歡迎畫面與最近的 repo、分支側欄（ahead/behind）、篩選列（文字、使用者、路徑、日期、分支）、篩選後以虛線連接、hash 跳轉、箭頭跳轉、commit 詳細資料、樹狀或平面的變更清單、diff 工具列、右鍵選單、快捷鍵、Refresh、Fetch、欄位與面板調整、深淺色主題、狀態列。 |
| 8.3 資源量測 | 見下表。 |

資源量測（Linux x86_64、Xvfb、WebKitGTK 軟體繪圖，git/git）：

| 項目 | Rebased 1.1.19 | Rebased Lite 0.1 |
|---|---|---|
| 開啟 repo 後的 RSS | 1,250 MB | 478 MB（app 194 + WebKit 網頁 246 + WebKit 網路 50） |
| 開啟 diff 後的 RSS | 未量測 | 552 MB |
| graph 計算（layout + IntelliSort） | 未量測 | 54 ms，Rust 核心峰值 38 MB |

macOS 的 WKWebView 數字會不同，還需要在 macOS 上量測。
