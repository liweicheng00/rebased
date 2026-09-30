// The Remotes dialog: the remotes of the repository with their URLs, and Add, Edit, Fetch and Remove.

import type { RemoteInfo } from "./api";
import { h } from "./dom";

export interface RemotesCallbacks {
  load: () => Promise<RemoteInfo[]>;
  add: () => Promise<void>;
  edit: (r: RemoteInfo) => Promise<void>;
  fetch: (r: RemoteInfo) => Promise<void>;
  remove: (r: RemoteInfo) => Promise<void>;
}

export async function openRemotesDialog(cb: RemotesCallbacks) {
  const list = h("div", { class: "remotes-list" });
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    // A dialog that one of the buttons opens handles its own keys.
    if (e.key === "Escape" && document.querySelectorAll(".overlay").length === 1) {
      e.preventDefault();
      close();
    }
  };
  const render = async () => {
    let remotes: RemoteInfo[];
    try {
      remotes = await cb.load();
    } catch (e) {
      list.replaceChildren(h("p", { class: "settings-hint error" }, String(e).replace(/^Error: /, "")));
      return;
    }
    const button = (label: string, title: string, run: () => Promise<void>) => {
      const b = h("button", { title }, label);
      b.addEventListener("click", async () => {
        await run();
        await render();
      });
      return b;
    };
    list.replaceChildren(
      ...(remotes.length
        ? remotes.map((r) =>
            h(
              "div",
              { class: "remote-row" },
              h("div", { class: "remote-text" }, h("b", {}, r.name), h("code", { class: "remote-url" }, r.fetchUrl), r.pushUrl ? h("code", { class: "remote-url" }, `push: ${r.pushUrl}`) : ""),
              h(
                "div",
                { class: "remote-actions" },
                button("Fetch", `Fetch ${r.name}`, () => cb.fetch(r)),
                button("Edit…", "Change the name or the URLs", () => cb.edit(r)),
                button("Remove…", `Remove ${r.name} and its remote branches`, () => cb.remove(r)),
              ),
            ),
          )
        : [h("p", { class: "settings-hint" }, "The repository has no remote.")]),
    );
  };
  const add = h("button", {}, "Add Remote…");
  add.addEventListener("click", async () => {
    await cb.add();
    await render();
  });
  const done = h("button", { class: "primary" }, "Close");
  done.addEventListener("click", close);
  const dialog = h(
    "div",
    { class: "dialog wide", role: "dialog", "aria-modal": "true", "aria-label": "Remotes" },
    h("div", { class: "dialog-title" }, "Remotes"),
    list,
    h("div", { class: "dialog-buttons" }, add, h("span", { class: "spacer" }), done),
  );
  const overlay = h("div", { class: "overlay" }, dialog);
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  await render();
}
