// Review Branch: start a review, open it, switch between reviews, and merge a reviewed branch.

import { api, type ReviewDetail, type ReviewSummary } from "./api";
import { showMenu } from "./context-menu";
import { confirmDialog, finishReviewDialog, formDialog } from "./dialogs";
import { runOp } from "./operations";
import { jumpToOid, loadReviews } from "./repo";
import { openReview } from "./review-view";
import { reviewPanel, showLeftTab } from "./shell";
import { app } from "./state";

const locals = () => app.refs.filter((b) => b.kind === "local").map((b) => b.name);

const BASES = ["main", "master", "develop"];

/** The base that a new review of `branch` likely wants: main, master or develop, if they exist. */
function guessBase(branch: string): string {
  const names = locals().filter((n) => n !== branch);
  return BASES.find((n) => names.includes(n)) ?? names[0] ?? "";
}

/** Asks for the branch and the base, starts the review, and opens it. */
export async function startReview(branch?: string) {
  const names = locals();
  if (names.length < 2) return void (await confirmDialog("Review Branch", "A review needs two local branches: the branch and its base.", "OK"));
  const cur = app.repoState?.branch ?? names[0];
  // The current branch, or else a recent branch that is not a usual base.
  const recent = app.recent.map((r) => r.name).filter((n) => names.includes(n));
  const b = branch ?? (!BASES.includes(cur) ? cur : [...recent, ...names].find((n) => !BASES.includes(n)) ?? names[0]);
  const r = await formDialog(
    "Review Branch",
    [
      { key: "branch", label: "Branch", type: "select", value: b, options: names.map((n) => [n, n]) },
      { key: "base", label: "Into (base)", type: "select", value: guessBase(b), options: names.map((n) => [n, n]) },
    ],
    "Start Review",
    "The review shows the changes of the branch from the commit where it started, as a pull request does. The notes and the viewed files stay in this repository only.",
  );
  if (!r) return;
  try {
    await api.reviewEdit({ action: "start", branch: String(r.branch), base: String(r.base) });
  } catch (e) {
    return void (await confirmDialog("Review Branch", String(e).replace(/^Error: /, ""), "OK"));
  }
  await loadReviews();
  showLeftTab("reviews");
  await openReviewWindow(String(r.branch));
}

/** Opens the Merge dialog and merges. True when the branch was merged. */
async function finish(d: ReviewDetail): Promise<boolean> {
  const choice = await finishReviewDialog(d);
  if (!choice) return false;
  const out = await runOp({ op: "finishReview", branch: d.summary.branch, ...choice }, `Merging ${d.summary.branch} into ${d.summary.base}`);
  await loadReviews();
  return !!out?.result.ok;
}

export async function finishReview(branch: string) {
  try {
    await finish(await api.review(branch));
  } catch (e) {
    await confirmDialog("Merge", String(e).replace(/^Error: /, ""), "OK");
  }
}

export async function openReviewWindow(branch: string) {
  await openReview(branch, {
    list: () => reviewPanel.all,
    load: (b) => api.review(b),
    edit: async (e) => {
      await api.reviewEdit(e);
      void loadReviews();
    },
    changes: async (l, r) => (await api.compare(l, r)).changes,
    pair: (l, r, path, oldPath) => api.filePair(l, r, path, oldPath),
    finish,
    showInLog: (oid) => void jumpToOid(oid, true),
  });
}

async function changeBase(r: ReviewSummary) {
  const names = locals().filter((n) => n !== r.branch);
  const f = await formDialog(`Base of ${r.branch}`, [{ key: "base", label: "Into (base)", type: "select", value: r.base, options: names.map((n) => [n, n]) }], "Change");
  if (!f) return;
  await api.reviewEdit({ action: "start", branch: r.branch, base: String(f.base) });
  await loadReviews();
}

reviewPanel.onNew = () => void startReview();
reviewPanel.onOpen = (r) => void openReviewWindow(r.branch);
reviewPanel.onFinish = (r) => void finishReview(r.branch);
reviewPanel.onMenu = (r, e) =>
  showMenu(e.clientX, e.clientY, [
    { label: "Open Review", action: () => void openReviewWindow(r.branch) },
    { label: `Merge into ${r.base}…`, disabled: !r.exists || r.merged, action: () => void finishReview(r.branch) },
    { label: "Change the Base…", action: () => void changeBase(r) },
    { separator: true },
    {
      label: "Remove Review…",
      action: async () => {
        if (!(await confirmDialog("Remove review", `Remove the review of ${r.branch} and its notes? The branch stays.`, "Remove", true))) return;
        await api.reviewEdit({ action: "remove", branch: r.branch });
        await loadReviews();
      },
    },
  ]);
