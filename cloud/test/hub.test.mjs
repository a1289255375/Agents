import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createHub, SessionError, sessionIdPattern } from "../src/hub.mjs";

const hold = { holdMs: 5000, via: "mcp" };
const roles = (hub, id) => hub.detail(id).timeline.map(({ role, text, state }) => (state ? `${role}:${text}:${state}` : `${role}:${text}`));

test("connect binds a session and an idle wait returns idle", async () => {
  const hub = createHub();
  const session = hub.connect({});
  assert.match(session.id, sessionIdPattern);
  assert.equal(session.name, "云端会话 1");
  assert.equal(hub.connect({ name: "重构任务" }).name, "重构任务");
  assert.deepEqual(hub.summaries().map(({ name, status }) => [name, status]), [["重构任务", "active"], ["云端会话 1", "active"]]);

  const pending = hub.wait(session.id, { holdMs: 40, via: "mcp" });
  assert.equal(hub.detail(session.id).status, "waiting");
  assert.deepEqual(hub.detail(session.id).waiting.via, "mcp");
  assert.deepEqual(await pending, { event: "idle" });
  assert.equal(hub.detail(session.id).hint, undefined);
});

test("an idle loop keeps the waiting status between two waits", async () => {
  let clock = 1_000_000;
  const hub = createHub({ now: () => clock });
  const { id } = hub.connect({});
  assert.deepEqual(await hub.wait(id, { holdMs: 20, via: "shell" }), { event: "idle" });
  assert.equal(hub.detail(id).status, "waiting");
  assert.deepEqual(hub.detail(id).waiting, { via: "shell", since: 1_000_000, holdMs: 20 });

  // The loop stopped: nobody came back for the next wait.
  clock += 16_000;
  assert.equal(hub.detail(id).status, "offline");
  assert.equal(hub.detail(id).waiting, undefined);

  // Anything else the agent does shows it is no longer just waiting.
  await hub.wait(id, { holdMs: 20, via: "mcp" });
  assert.equal(hub.detail(id).status, "waiting");
  hub.progress(id, "顺手做点别的");
  assert.equal(hub.detail(id).status, "active");
  await hub.wait(id, { holdMs: 20, via: "mcp" });
  hub.record({ session: id, tool: "read_file", ok: true, target: "a.txt" });
  assert.equal(hub.detail(id).status, "active");
  await hub.wait(id, { holdMs: 20, via: "mcp" });
  assert.equal(hub.connect({ id }).id, id);
  assert.equal(hub.detail(id).status, "active");
});

test("a message wakes the pending wait and stays until the reply acknowledges it", async () => {
  const hub = createHub();
  const { id } = hub.connect({});
  const pending = hub.wait(id, hold);
  hub.send(id, "改一下 README");
  assert.deepEqual(await pending, { event: "message", seq: 1, message: "改一下 README", redelivered: false, queued: 0 });
  assert.equal(hub.detail(id).status, "working");
  assert.deepEqual(roles(hub, id), ["note:云端 Agent 已接入", "user:改一下 README:delivered"]);

  hub.progress(id, "正在读文件");
  assert.deepEqual(hub.reply(id, "改好了"), { event: "replied", queued: 0 });
  assert.equal(hub.detail(id).status, "active");
  assert.deepEqual(roles(hub, id).slice(1), ["user:改一下 README:done", "progress:正在读文件", "assistant:改好了"]);
  assert.equal(hub.detail(id).preview, "改好了");

  // Nothing is left to deliver.
  assert.deepEqual(await hub.wait(id, { holdMs: 30, via: "mcp" }), { event: "idle" });
});

test("messages sent while the agent is busy queue up and arrive one per wait", async () => {
  const hub = createHub();
  const { id } = hub.connect({});
  hub.send(id, "一");
  hub.send(id, "二");
  hub.send(id, "三");
  assert.equal(hub.detail(id).queued, 3);

  assert.deepEqual(hub.wait(id, hold), { event: "message", seq: 1, message: "一", redelivered: false, queued: 2 });
  assert.deepEqual(hub.progress(id, "处理中"), { event: "progress", queued: 2 });
  assert.deepEqual(hub.reply(id, "一 完成"), { event: "replied", queued: 2 });
  assert.deepEqual(hub.wait(id, hold), { event: "message", seq: 2, message: "二", redelivered: false, queued: 1 });
  hub.reply(id, "二 完成");
  assert.deepEqual(hub.wait(id, hold), { event: "message", seq: 3, message: "三", redelivered: false, queued: 0 });
  assert.deepEqual(roles(hub, id).filter((item) => item.startsWith("user")), ["user:一:done", "user:二:done", "user:三:delivered"]);
});

test("a delivery whose response was lost is delivered again, and never after the reply", async () => {
  const hub = createHub();
  const { id } = hub.connect({});
  hub.send(id, "任务");
  assert.equal(hub.wait(id, hold).redelivered, false);
  // The agent never saw the response (timeout, dropped tunnel) and simply waits again.
  assert.deepEqual(hub.wait(id, hold), { event: "message", seq: 1, message: "任务", redelivered: true, queued: 0 });
  assert.deepEqual(hub.wait(id, hold), { event: "message", seq: 1, message: "任务", redelivered: true, queued: 0 });
  hub.reply(id, "完成");
  assert.deepEqual(await hub.wait(id, { holdMs: 30, via: "mcp" }), { event: "idle" });
});

test("a retried reply is shown once, an identical answer to a new message is kept", () => {
  const hub = createHub();
  const { id } = hub.connect({});
  hub.send(id, "ping");
  hub.wait(id, hold);
  hub.reply(id, "pong");
  hub.reply(id, "pong");
  hub.send(id, "ping");
  hub.wait(id, hold);
  hub.reply(id, "pong");
  assert.deepEqual(roles(hub, id).slice(1), ["user:ping:done", "assistant:pong", "user:ping:done", "assistant:pong"]);
});

test("a newer wait supersedes the older one and the cut-off is remembered as a hint", async () => {
  const hub = createHub();
  const { id } = hub.connect({});
  const first = hub.wait(id, { holdMs: 5000, via: "mcp" });
  await sleep(30);
  const second = hub.wait(id, hold);
  assert.deepEqual(await first, { event: "superseded" });
  const { hint } = hub.detail(id);
  assert.equal(hint.holdMs, 5000);
  assert.ok(hint.afterMs >= 25 && hint.afterMs < 2000);

  // Only the newest wait receives the message.
  hub.send(id, "给新的等待");
  assert.equal((await second).message, "给新的等待");
});

test("a polling loop that was replaced cannot take the wait back", async () => {
  const hub = createHub();
  const { id } = hub.connect({});
  const poll = (loop, holdMs = 5000) => hub.wait(id, { holdMs, via: "shell", loop });

  // The polls of one loop follow each other without superseding anything.
  assert.deepEqual(await poll("a", 20), { event: "idle" });
  const inFlight = poll("a");

  // The agent moved on to wait_message: the poll in flight ends, and so does the loop's next one.
  const viaMcp = hub.wait(id, hold);
  assert.deepEqual(await inFlight, { event: "superseded" });
  assert.deepEqual(poll("a"), { event: "superseded" });
  assert.equal(hub.detail(id).waiting.via, "mcp");
  // Leaving a shell loop is no sign of a connection being cut.
  assert.equal(hub.detail(id).hint, undefined);

  // A loop started later is the newest wait. The one it replaces stays out as well.
  const next = poll("b");
  assert.deepEqual(await viaMcp, { event: "superseded" });
  const newer = poll("c");
  assert.deepEqual(await next, { event: "superseded" });
  assert.deepEqual(poll("b"), { event: "superseded" });
  assert.deepEqual(poll("a"), { event: "superseded" });

  hub.send(id, "给最新的循环");
  assert.equal((await newer).message, "给最新的循环");
  // The loop that got the message goes on after the reply.
  hub.reply(id, "好");
  assert.deepEqual(await poll("c", 20), { event: "idle" });

  // A poll that is cut off says nothing either: the shell tool stopping the command looks the same.
  const controller = new AbortController();
  const cut = hub.wait(id, { holdMs: 5000, via: "shell", loop: "c", signal: controller.signal });
  controller.abort();
  assert.deepEqual(await cut, { event: "aborted" });
  assert.equal(hub.detail(id).hint, undefined);
});

test("an aborted wait loses nothing: the message is delivered to the next wait", async () => {
  const hub = createHub();
  const { id } = hub.connect({});
  const controller = new AbortController();
  const pending = hub.wait(id, { ...hold, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending, { event: "aborted" });
  assert.equal(hub.detail(id).hint.holdMs, 5000);
  assert.deepEqual(hub.wait(id, { ...hold, signal: controller.signal }), { event: "aborted" });

  hub.send(id, "断线期间发的");
  assert.equal(hub.detail(id).queued, 1);
  assert.deepEqual(hub.wait(id, hold), { event: "message", seq: 1, message: "断线期间发的", redelivered: false, queued: 0 });

  // A wait that runs its full length clears the hint.
  hub.reply(id, "ok");
  await hub.wait(id, { holdMs: 30, via: "mcp" });
  assert.equal(hub.detail(id).hint, undefined);
});

test("an unknown id is adopted so the agent's loop survives a restart of the service", async () => {
  const hub = createHub();
  const pending = hub.wait("0123abcd", hold);
  assert.equal(hub.detail("0123abcd").status, "waiting");
  assert.match(hub.detail("0123abcd").timeline[0].text, /服务重启后/);
  hub.send("0123abcd", "还在吗");
  assert.equal((await pending).message, "还在吗");
  assert.equal(hub.reply("89abcdef", "对一个新 id 回复也会接管").event, "replied");
  assert.equal(hub.summaries().length, 2);
});

test("disconnect ends the wait and the id stays closed until it connects again", async () => {
  const hub = createHub();
  const { id } = hub.connect({});
  const pending = hub.wait(id, hold);
  hub.disconnect(id, "user");
  assert.deepEqual(await pending, { event: "disconnected" });
  assert.equal(hub.detail(id).status, "disconnected");
  assert.equal(hub.detail(id).closed, "user");
  assert.deepEqual(hub.wait(id, hold), { event: "disconnected" });
  assert.deepEqual(hub.reply(id, "太晚了"), { event: "disconnected" });
  assert.deepEqual(hub.progress(id, "太晚了"), { event: "disconnected" });
  assert.throws(() => hub.send(id, "x"), SessionError);
  assert.equal(roles(hub, id).includes("assistant:太晚了"), false);

  // connect_session with the old id opens it again.
  assert.equal(hub.connect({ id }).id, id);
  assert.equal(hub.detail(id).status, "active");
  hub.send(id, "又能发了");
  assert.equal(hub.wait(id, hold).message, "又能发了");
  hub.send(id, "这条来不及投递");

  hub.disconnect(id, "agent");
  assert.equal(hub.detail(id).closed, "agent");
  assert.equal(roles(hub, id).at(-1), "note:云端 Agent 结束了这个会话");
  assert.deepEqual(roles(hub, id).filter((item) => item.startsWith("user")), ["user:又能发了:delivered", "user:这条来不及投递:undelivered"]);
});

test("a removed session is gone and its id is not adopted again", () => {
  const hub = createHub();
  const { id } = hub.connect({});
  hub.remove(id);
  assert.equal(hub.detail(id), undefined);
  assert.deepEqual(hub.summaries(), []);
  assert.deepEqual(hub.wait(id, hold), { event: "disconnected" });
  assert.deepEqual(hub.summaries(), []);
  assert.throws(() => hub.send(id, "x"), /会话不存在/);
});

test("status turns offline when the agent stops calling", () => {
  let clock = 1_000_000;
  const hub = createHub({ now: () => clock });
  const { id } = hub.connect({});
  assert.equal(hub.detail(id).status, "active");
  clock += 16_000;
  assert.equal(hub.detail(id).status, "offline");
  // A message for an agent that is not listening waits in the queue.
  hub.send(id, "有人吗");
  assert.equal(hub.detail(id).status, "offline");
  assert.equal(hub.detail(id).queued, 1);
  assert.equal(hub.wait(id, hold).message, "有人吗");
  clock += 600_000;
  assert.equal(hub.detail(id).status, "working");
});

test("activity is attributed to a session and job entries update in place", () => {
  const hub = createHub();
  assert.equal(hub.attribute(undefined), undefined);
  const first = hub.connect({});
  assert.equal(hub.attribute(undefined), first.id);
  assert.equal(hub.attribute("ffffffff"), first.id);
  const second = hub.connect({});
  assert.equal(hub.attribute(undefined), undefined);
  assert.equal(hub.attribute(second.id), second.id);
  hub.disconnect(second.id, "user");
  assert.equal(hub.attribute(undefined), first.id);

  const before = hub.revision;
  hub.record({ session: first.id, tool: "read_file", ok: true, target: "a.txt" });
  hub.recordJob({ id: "c1", session: first.id, command: "npm test", state: "running", outputTail: "" });
  hub.recordJob({ id: "c1", session: first.id, command: "npm test", state: "exited", outputTail: "ok\n" });
  const entries = hub.activitySince(before);
  assert.deepEqual(entries.map(({ n, tool, target }) => [n, tool, target]), [[1, "read_file", "a.txt"], [2, "run_command", "npm test"]]);
  assert.equal(entries[1].job.state, "exited");
  assert.equal(entries[1].rev, hub.revision);
  // A client that already has the first entry only receives what changed after it.
  assert.deepEqual(hub.activitySince(entries[0].rev).map((entry) => entry.n), [2]);
  assert.deepEqual(hub.activitySince(hub.revision), []);
});

test("watch resolves on the next change, on timeout and on abort", async () => {
  const hub = createHub();
  const { id } = hub.connect({});
  const revision = hub.revision;
  await hub.watch(revision - 1, 5000);

  let woke = false;
  const watching = hub.watch(revision, 5000).then(() => { woke = true; });
  await sleep(20);
  assert.equal(woke, false);
  hub.send(id, "x");
  await watching;
  assert.ok(hub.revision > revision);

  const started = Date.now();
  await hub.watch(hub.revision, 40);
  assert.ok(Date.now() - started >= 30);

  const controller = new AbortController();
  const aborted = hub.watch(hub.revision, 5000, controller.signal);
  controller.abort();
  await aborted;
  hub.notify();
  assert.ok(hub.revision > revision + 1);
});

test("a key always leads back to the same session", () => {
  const hub = createHub();
  const first = hub.connect({ name: "甲", key: "conversation-1", meta: { conversation: "conversation-1" } });
  const other = hub.connect({ key: "conversation-2" });
  assert.notEqual(first.id, other.id);

  const again = hub.connect({ key: "conversation-1" });
  assert.equal(again.id, first.id);
  assert.equal(again.name, "甲");
  assert.deepEqual(hub.summaries().map(({ key, meta }) => [key, meta?.conversation]), [["conversation-2", undefined], ["conversation-1", "conversation-1"]]);
  assert.deepEqual(roles(hub, first.id), ["note:云端 Agent 已接入", "note:云端 Agent 重新接入"]);

  // A session the user ended opens again for the same caller; a deleted one starts afresh.
  hub.disconnect(first.id, "user");
  assert.equal(hub.connect({ key: "conversation-1" }).id, first.id);
  assert.equal(hub.detail(first.id).status, "active");
  hub.remove(first.id);
  assert.notEqual(hub.connect({ key: "conversation-1" }).id, first.id);
});

test("thinking is kept in the timeline, on its own and in front of a reply", async () => {
  const hub = createHub();
  const { id } = hub.connect({});
  hub.send(id, "修复登录");
  hub.wait(id, hold);
  assert.deepEqual(hub.think(id, "先看 auth.js"), { event: "thinking", queued: 0 });
  hub.send(id, "第二件事");
  assert.deepEqual(hub.think(id, "问题在令牌过期判断"), { event: "thinking", queued: 1 });
  assert.deepEqual(hub.reply(id, "修好了", "改了过期判断，补了测试"), { event: "replied", queued: 1 });
  // A retried reply shows neither the answer nor its thinking twice.
  hub.reply(id, "修好了", "改了过期判断，补了测试");
  assert.deepEqual(roles(hub, id).slice(1), [
    "user:修复登录:done", "thinking:先看 auth.js", "user:第二件事:queued", "thinking:问题在令牌过期判断",
    "thinking:改了过期判断，补了测试", "assistant:修好了",
  ]);
  assert.deepEqual([hub.detail(id).delivered, hub.detail(id).acked], [1, 1]);
  assert.equal(hub.summaries()[0].preview, "修好了");

  hub.disconnect(id, "user");
  assert.deepEqual(hub.think(id, "太晚了"), { event: "disconnected" });
});
