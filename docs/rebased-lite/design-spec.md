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

## 11. 實作狀態（v0.4，2026-09-28）

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
| 收合線性分支（v0.3） | 完成。移植 IntelliJ 的 `LinearFragmentGenerator` 規則（短片段上限 10、有 ref 的 commit 不收合）。可以全部收合、全部展開、收合單一分支，點虛線展開。git/git 從 85,787 列降到 49,818 列，約 350 ms。跳到被收合的 commit 時，自動展開該片段。 |
| 寫入操作（v0.3） | 完成：checkout（分支、遠端分支、revision）、新增分支與 tag、改名、刪除、merge、rebase、cherry-pick、revert、reset（soft、mixed、keep、hard）、編輯訊息、squash、drop、互動式 rebase。squash、drop、編輯訊息、互動式 rebase 在記憶體中執行（`git merge-tree --write-tree` 與 `git commit-tree`），有衝突時不改動任何檔案或 ref。每個操作完成後的通知有 Undo。進行中的 merge、rebase、cherry-pick、revert 會顯示橫幅，列出衝突檔案，並提供 Mark Resolved、Abort、Continue。已推送的 commit 在改寫前會警告。 |
| 深色模式（v0.3） | 完成。淺色、深色、跟隨系統三種。所有新的對話框、通知、橫幅都支援兩種主題。原生 Linux 視窗會跟隨 GTK 的深色主題。 |
| Worktree 管理（v0.3） | 完成：列出、新增（新分支或既有分支、指定起點）、開啟、移除（有變更時再確認後強制移除）、prune。 |
| 近期分支（v0.3） | 完成。從 HEAD reflog 讀出近期切換過的分支，顯示在側欄最上方與工具列的分支切換器。 |
| Changelist 與 Commit（v0.4） | 完成。Commit 分頁把本機變更分成多個 changelist。新的變更進入 active changelist。可以用右鍵選單或拖放移動檔案。每個 changelist 保留自己的 commit 訊息草稿。勾選的檔案才會進 commit（`git commit --only`），其他檔案的 staged 內容不變，hook 照常執行。merge 進行中時改為 commit 整個 index。也有 Amend、Rollback、Add to Git、刪除未追蹤檔、Undo commit（變更回到本機變更）。changelist 依 worktree 存在 git 目錄裡。 |
| 部分 commit（v0.4） | 完成。本機檔案的 diff 裡每個變更都有勾選框。取消勾選的變更留在本機。這種 commit 在暫存 index 裡用 `git commit-tree` 建立，所以不會執行 hook。 |
| Push 與 Update（v0.4） | 完成。Push 對話框列出要推送的 commit，可選 remote、遠端分支、force with lease、tags、設定追蹤分支。被拒絕時提供 Update。Update 先 fetch，再 merge 或 rebase，本機變更自動 stash 後還原。Commit 分頁有 Commit and Push。 |
| Stash（v0.4） | 完成。Stash 分頁列出 stash，選取後顯示檔案與 diff（含未追蹤檔）。可以 Apply、Pop、連同 staged 狀態 Apply、從 stash 建立分支、Drop。可以 stash 全部、選取的檔案或一個 changelist。 |
| 衝突與合併視窗（v0.4） | 完成。Conflicts 對話框（Accept Yours、Accept Theirs、Merge…）。三欄合併視窗：你的版本、結果、對方版本，三欄對齊並同步捲動，可逐一套用或忽略每個變更、把第二邊附加到衝突、一次套用所有不衝突的變更。結果可以直接編輯。merge 與 rebase 會顯示正確的兩邊名稱。 |
| 檔案歷史與 Annotate（v0.4） | 完成。Show History 追蹤改名，顯示每個 commit 對這個檔案的變更。Annotate（git blame）在行號欄顯示日期與作者，依時間上色，點擊可跳到 commit。可用於 commit、本機變更（未 commit 的行會標出）與歷史視窗。 |
| 檔案層級操作（v0.4） | 完成。變更清單可以多選。對 commit 中的檔案：Revert Selected Changes、Cherry-Pick Selected Changes、Get from Revision。 |
| 互動式 rebase 的 Edit（v0.4） | 完成。有 Edit 步驟時改用真正的 `git rebase -i`（由程式寫入 todo，訊息用 `exec git commit --amend` 設定），在該 commit 停下。橫幅顯示停在哪個 commit，工具列顯示 rebasing 的分支。修改檔案後在 Commit 分頁 Amend，再按 Continue。本機變更會自動 stash 後還原。 |
| 分支比較（v0.4） | 完成。分支選單的 Show Commits Not in &lt;目前分支&gt; 與反向，log 只顯示一邊有而另一邊沒有的 commit。 |
| 自動重新整理（v0.5） | 完成。監看工作目錄與 git 目錄。外部編輯的檔案、終端機裡的 commit 與分支、fetch 在約一秒內出現。git 忽略的檔案不觸發重新整理。讀取時設定 `GIT_OPTIONAL_LOCKS=0`，所以 app 自己的讀取不會改寫 index。 |
| 密碼與 passphrase（v0.5） | 完成。app 本身是 `GIT_ASKPASS` 與 `SSH_ASKPASS` 程式，透過 Unix socket 把提示送回 app，由對話框回答。可以記住答案到 app 關閉。 |
| 簽章與 hook（v0.5） | 完成。app 自己寫的 commit（squash、drop、reword、部分 commit）在 `commit.gpgsign` 開啟時簽章。部分 commit 執行 pre-commit、commit-msg、post-commit hook。 |
| Undo（v0.5） | 完成。每個操作回傳一串 Undo 步驟（reset、checkout、建立或刪除 ref、改名、還原 stash）。支援 checkout、新增分支與 tag、改名、刪除分支與 tag、merge、rebase、cherry-pick、revert、update、reset、改寫、commit、drop stash。HEAD 在操作後移動過時拒絕 Undo。`Ctrl/Cmd+Z` 復原上一個操作。 |
| Local History（v0.5） | 完成。watcher 在檔案變更時保存版本；Rollback、刪除未追蹤檔、Get from Revision、Apply Changes、hard reset、stash、resolve 之前也保存。存在 git 目錄的 `rebased-lite/local-history`（`index.jsonl` 與 gzip 壓縮的 blob）。保留 5 天、最多 200 MB。視窗顯示版本與目前檔案的 diff，可以 Revert。 |
| Submodule（v0.5） | 完成。Branches 分頁列出 submodule 與狀態（未初始化、其他 commit、有本機變更）。可以 Update（init 後 checkout 記錄的 commit）與開啟。diff 顯示 `Subproject commit <hash>`。Rollback 會 checkout 記錄的 commit。checkout、merge、rebase、reset、update 改變記錄的 commit 後，通知提供 Update Submodules。watcher 不監看 submodule 內部。 |
| Git LFS（v0.5） | 完成。commit 裡的 LFS 檔案，物件已下載時 diff 顯示真實內容，否則顯示 pointer 與說明。部分 commit 用 `git hash-object --path` 執行 clean filter，所以 LFS 檔案存成 pointer（修正前會存成真實內容）。 |
| 部分 changelist（v0.5） | 完成。同一檔案的不同 hunk 可以在不同 changelist。hunk 來自 `git diff -U0 HEAD`，ID 是刪除行與新增行的雜湊，所以其他 hunk 改變時 ID 不變。在 diff 右鍵「Move Change to Another Changelist」。commit 一個 changelist 時，後端用 HEAD 加上該 changelist 的 hunk 組出內容，再用部分 commit 寫入。Rollback 只還原該 changelist 的 hunk。存在 `changelists.json`，重新開啟後保留。 |
| 多 repo 分頁（v0.5） | 完成。後端為每個 repo 保留一個 session（graph、watcher、Local History），`activate` 切換使用中的 repo，不重新載入；`close` 釋放它。前端每個分頁保留篩選與選取的 commit。分頁在下次啟動時回來，只有使用中的分頁立即載入。每個開啟的 repo 都占用自己的記憶體（git/git 約 40 MB）。 |
| 設定畫面（v0.5） | 完成。分為 General（主題、Update 預設、自動重新整理、自動 fetch 間隔）、Git（執行檔路徑，Test 會顯示版本；不是 git 的程式會被拒絕）、Diff（字型大小與字型、選項）、Local History（天數與大小上限）、Keymap（所有全域動作的快捷鍵，可多個、可錄製、衝突標紅、可重設）。後端所有 git 指令都經過 `git_command()`，使用設定的執行檔。 |
| 8.3 資源量測 | 見下表。 |

資源量測（Linux x86_64、Xvfb、WebKitGTK 軟體繪圖，git/git）：

| 項目 | Rebased 1.1.19 | Rebased Lite 0.1 |
|---|---|---|
| 開啟 repo 後的 RSS | 1,250 MB | 478 MB（app 194 + WebKit 網頁 246 + WebKit 網路 50） |
| 開啟 diff 後的 RSS | 未量測 | 552 MB |
| graph 計算（layout + IntelliSort） | 未量測 | 54 ms，Rust 核心峰值 38 MB |

v0.4 的量測（同一台機器、同樣條件，git/git，開啟後 20 秒）：

| 項目 | v0.2 的前端 | v0.4 的前端 |
|---|---|---|
| WebKit 網頁行程 | 603 MB | 598 MB |
| 總計（app + WebKit 網頁 + WebKit 網路） | 未取得 app 行程的數字 | 865 MB（218 + 598 + 48） |

新功能沒有增加記憶體：兩個前端在同樣條件下差不多。但這次的絕對數字比上表 v0.1 的數字高（網頁行程 598 MB 對 246 MB）。JavaScript heap 只有 16 MB，DOM 約 1,600 個節點，所以差異在 WebKit 本身（繪圖或編譯後的程式碼），不在前端資料。原因還沒有找到。Rebased 1.1.19 這次沒有重新量測，所以不能直接和上表的 1,250 MB 比較。

### 記憶體瓶頸分析（v0.4.1）

量測方法：Linux x86_64、Xvfb（沒有 GPU），git/git，開啟後 20 秒，量三個行程（app、WebKit 網頁、WebKit 網路）的 RSS。RSS 會把共用函式庫在每個行程各算一次，所以另外列出 PSS（共用頁面依行程數平分），PSS 的總和才是實際占用。

| 實驗 | 總 RSS | 網頁行程 RSS |
|---|---|---|
| 優化前的預設 | 850 MB | 582 MB |
| 關閉 WebKit 的 DMABUF renderer | 552 MB | 311 MB |
| 再關閉 JavaScriptCore 的 JIT（只為量測） | 485 MB | 245 MB |
| 只保留 baseline JIT（關閉 DFG、FTL） | 532 MB | 289 MB |
| 沒有 Monaco（只為量測） | 424 MB | 186 MB |
| 載入精簡的 Monaco，但不建立編輯器（只為量測） | 463 MB | 219 MB |
| 精簡的 Monaco | 529 MB | 287 MB |
| 延後建立單一編輯器 | 549 MB | 306 MB |
| 不用 diff worker（只為量測） | 535 MB | 292 MB |

Rust 核心（dev server 開啟 git/git）只用 41.6 MB。

瓶頸依大小排列：

1. **沒有 GPU 時的 WebKit 合成（約 280 MB）。** WebKitGTK 用 OpenGL 合成畫面。沒有 GPU 時，Mesa 用 CPU 模擬 OpenGL（llvmpipe），GL 緩衝區放在一般記憶體裡，兩個行程還各載入約 50 MB 的 libLLVM。這也是 v0.1 量到 478 MB、之後量到 865 MB 的原因：量測環境不同，不是新功能造成的。**已修正：** app 在 Linux 上找不到 GPU（`/dev/dri/renderD*`）時，設定 `WEBKIT_DISABLE_DMABUF_RENDERER=1`，改用 WebKit 的軟體繪圖路徑。使用者自己設定的值優先。有 GPU 的機器維持原樣。macOS 的 WKWebView 用 GPU 行程，不受影響。
2. **Monaco（約 100–125 MB）。** 其中約 33 MB 是載入程式碼。其餘是 JavaScriptCore 為執行過的程式產生的 bytecode 和 JIT 程式碼，以及編輯器實例。**已修正一部分：** 只載入用到的 Monaco 功能（bundle 從 3.36 MB 降到 2.87 MB，開啟時約 −24 MB），單一編輯器（新增或刪除的檔案）在第一次使用時才建立（約 −5 MB）。更大的節省需要換掉 Monaco，這會改變編輯器的體驗，需要先決定。
3. **WebKit 與 GTK 的固定成本。** app 行程約 190 MB RSS（PSS 約 125 MB），其中 Rust 核心只有 41.6 MB，其餘是 GTK 和 WebKit 的 UI 端。網路行程固定約 48 MB。這部分只能靠換掉 WebView 才能降低。
4. **JIT。** 關閉 DFG 和 FTL 可以再省約 22 MB，但 JavaScript 會變慢，所以沒有採用。

使用 2 分鐘後（點選 12 個 commit、開啟 diff）：

| 版本 | 總 RSS | 總 PSS |
|---|---|---|
| 優化前 | 968 MB | 767 MB |
| 優化後 | 541 MB | 386 MB |
| Rebased 1.1.19（同一天、同樣環境，開啟 5 分鐘後） | 1,479 MB（GC 後 1,305 MB） | 單一 JVM 行程，RSS 約等於 PSS |

Rebased 的 1,479 MB 裡，Java heap、metaspace 和 native malloc 占 830 MB，jar 檔映射占 269 MB，native 函式庫占 98 MB。它用 Java2D 軟體繪圖，不受上面 WebKit 合成問題的影響。

macOS 的 WKWebView 數字會不同，還需要在 macOS 上量測。

v0.4 沒有做的事：
- diff 勾選框的部分 commit 選擇只存在記憶體中。要保留選擇，請把變更移到另一個 changelist。
- 沒有 TextMate 上色（見 6.3）。
- 所有功能只在 Linux 上測試過，還沒有在 macOS 上測試。
