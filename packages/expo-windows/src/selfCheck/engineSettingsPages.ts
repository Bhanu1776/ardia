import { engineAvailable, hostCall, leaveOffersFromUnheard } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { evaluate, firstWindow, hide, LEFT, listed, pause, show, until } from "./engineSleep";

const SETTINGS = "chrome://settings/searchEngines";
const LOAD_MS = 20000;
const ANSWER_MS = 4000;
const SETTLE_MS = 500;
const CHECK_SITE = "https://ardia-settings-check.example:443";
const PRIVATE_PROFILE = "settings-check@";

type Changed = { error?: string; switched?: boolean; restored?: boolean; listed?: boolean; cleared?: boolean };

const step = (what: string) => console.info(`[ardia windows] settings step: ${what}`);

const ASK = `const ask = (target, name, ...args) => new Promise((resolve, reject) => {
  const id = "ardia-check-" + name + "-" + Math.random();
  const cr = target.cr;
  const prior = cr.webUIResponse;
  const timer = setTimeout(() => { cr.webUIResponse = prior; reject(new Error(name + " gave no answer")); }, ${ANSWER_MS});
  cr.webUIResponse = (callbackId, ok, response) => {
    if (callbackId !== id) return prior(callbackId, ok, response);
    clearTimeout(timer);
    cr.webUIResponse = prior;
    ok ? resolve(response) : reject(new Error(String(response)));
  };
  target.chrome.send(name, [id, ...args]);
});
const answer = (work) => work.then((result) => post("result", JSON.stringify(result)), (error) => post("result", JSON.stringify({ error: String(error) })));`;

const SEARCH_ENGINE = (target: string) => `${ASK}
const at = ${target};
const engines = (lists) => [...lists.defaults, ...lists.actives, ...lists.others];
const chosen = (lists) => engines(lists).find((engine) => engine.default);
answer((async () => {
  const before = await ask(at, "getSearchEnginesList");
  const current = chosen(before);
  const other = engines(before).find((engine) => !engine.default && String(engine.id).startsWith("db:"));
  if (!current || !other) return { error: "no second search engine to choose: " + JSON.stringify(engines(before).map((engine) => engine.id)) };
  at.chrome.send("setDefaultSearchEngine", [other.id, 1, null]);
  const switched = chosen(await ask(at, "getSearchEnginesList"))?.id === other.id;
  at.chrome.send("setDefaultSearchEngine", [current.id, 1, null]);
  const restored = chosen(await ask(at, "getSearchEnginesList"))?.id === current.id;
  return { switched, restored };
})());`;

const SITE_PERMISSION = (target: string) => `${ASK}
const at = ${target};
const named = (list) => JSON.stringify(list).includes("ardia-settings-check.example");
answer((async () => {
  at.chrome.send("setCategoryPermissionForPattern", ["${CHECK_SITE}", "", "notifications", "block", false]);
  const listed = named(await ask(at, "getExceptionList", "notifications"));
  at.chrome.send("resetCategoryPermissionForPattern", ["${CHECK_SITE}", "", "notifications", false]);
  const cleared = !named(await ask(at, "getExceptionList", "notifications"));
  return { listed, cleared };
})());`;

const READY = (target: string) => `post("result", JSON.stringify(!!(${target} && ${target}.document.readyState === "complete" && ${target}.cr && ${target}.cr.webUIResponse && ${target}.chrome && ${target}.chrome.send)));`;

async function engineAlive(key: string, where: string) {
  await pause(SETTLE_MS);
  const tabs = (await hostCall<{ tabs?: { key: string }[] }>("tabs.list")).tabs ?? [];
  expectTrue(tabs.some((tab) => tab.key === key), `the engine still lists the settings page after the change ${where}`);
  expectEqual(await evaluate(key, 'post("result", JSON.stringify(location.href.startsWith("chrome://settings")));'), true, `the settings page still answers after the change ${where}`);
}

async function changeBoth(key: string, target: string, where: string) {
  await until(`the settings page ${where} has its handlers`, LOAD_MS, () => evaluate(key, READY(target)).catch(() => false), (ready) => ready === true);
  step(`setDefaultSearchEngine ${where}`);
  expectEqual((await evaluate(key, SEARCH_ENGINE(target))) as Changed, { switched: true, restored: true }, `the default search engine changes and changes back ${where}`);
  await engineAlive(key, `of search engine ${where}`);
  step(`setCategoryPermissionForPattern ${where}`);
  expectEqual((await evaluate(key, SITE_PERMISSION(target))) as Changed, { listed: true, cleared: true }, `a site's notification permission is set and reset ${where}`);
  await engineAlive(key, `of site permission ${where}`);
}

async function withSettings(name: string, profile: string, run: (key: string, windowId: string) => Promise<void>) {
  const key = `self-check-settings-${name}`;
  const windowId = await firstWindow();
  try {
    await hostCall("tab.create", { key, url: SETTINGS, profile }, windowId);
    await until(`the settings page ${key} loads`, LOAD_MS, () => listed(key), (tab) => tab?.loading === false && String(tab?.url ?? "").length > 0);
    await run(key, windowId);
  } finally {
    await hostCall("tab.close", { key }).catch(() => null);
    if (profile) await hostCall("profile.release", { profile }).catch(() => null);
  }
}

const settingsChecks: Check[] = [
  {
    name: "engine settings: changing the default search engine and a site permission in a shown chrome://settings page leaves the engine running",
    run: () =>
      withSettings("shown", "", async (key, windowId) => {
        await show(key, windowId, LEFT);
        await changeBoth(key, "window", "in a shown page");
      }),
  },
  {
    name: "engine settings: a private page asked for chrome://settings either opens it and survives the same changes, or doesn't open it",
    run: () =>
      withSettings("private", PRIVATE_PROFILE, async (key, windowId) => {
        await show(key, windowId, LEFT);
        const url = String((await listed(key))?.url ?? "");
        step(`a private page asked for ${SETTINGS} is at ${url}`);
        if (!url.startsWith("chrome://settings")) return;
        await changeBoth(key, "window", "in a private page");
      }),
  },
  {
    name: "engine settings: the same changes in a chrome://settings pop-up the app has not adopted leave the engine running",
    run: () =>
      withSettings("opener", "", async (key, windowId) => {
        await show(key, windowId, LEFT);
        leaveOffersFromUnheard(key);
        try {
          expectEqual(await evaluate(key, `window.settingsPopup = window.open("${SETTINGS}"); post("result", JSON.stringify(!!window.settingsPopup));`, true), true, "the settings page opens a settings pop-up");
          await changeBoth(key, "window.settingsPopup", "in a pop-up");
        } finally {
          leaveOffersFromUnheard(null);
          await evaluate(key, 'if (window.settingsPopup) window.settingsPopup.close(); post("result", "true");').catch(() => null);
        }
      }),
  },
  {
    name: "engine settings: the same changes in a chrome://settings page whose window is hidden leave the engine running",
    run: () =>
      withSettings("hidden", "", async (key, windowId) => {
        await show(key, windowId, LEFT);
        await hide(key, windowId);
        await changeBoth(key, "window", "in a hidden page");
      }),
  },
];

export const checks: Check[] = engineAvailable() ? settingsChecks : [];
