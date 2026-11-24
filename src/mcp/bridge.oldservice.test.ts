import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { QuestionPrompt } from "@shared/questions";
import { ManualExecutor, until } from "../server/testing";
import { EnsembleBridge } from "./bridge";
import { closeTestBridges, connectBridge, simulateOlderService, startTestService } from "./bridge.fixtures";
import { ServiceClient } from "./client";

/**
 * 会改状态的请求对老服务：新桥按 `features` 在发之前就把老服务做不了的事拒绝掉（见 bridge.questions.test.ts、bridge.rediscovery.test.ts 等）。
 * 但发送时连接被拒绝（服务重启了），桥重新发现服务，连上的可能是另一个版本——请求之前的那次检查是按旧服务做的。
 * 回复提问就是这样一个请求：老服务没有这条路由，请求会撞上 404，主 Agent 读到的是一句对不上号的“列出有效的会话编号”，而不是“服务比插件旧、请用户去面板里回答”。
 * 这里在 POST 的那一刻把服务换成“老服务”（只是改 service.json，服务本身还是新的），看桥发出了什么、对主 Agent 说了什么。
 * 用真服务（临时状态目录、模拟执行端）与进程内的 MCP 客户端；“桥 ↔ 服务”仍是真实的本地 HTTP，只有被拒绝的那一次是造出来的。
 */

afterEach(closeTestBridges);

interface Sent {
  method: string;
  path: string;
  body: string | undefined;
}

/** 与连接被拒绝时 fetch 抛出的错误同一个形状：TypeError，原因里带 ECONNREFUSED。 */
function connectionRefused(): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });
}

/** 回复提问的路由：`/api/sessions/<id>/questions/<qid>/answer` 与 `/decline`。 */
const QUESTION_REPLY = /\/questions\/[^/]+\/(?:answer|decline)$/;

const CHOICE: QuestionPrompt[] = [
  {
    key: "pkg",
    text: "Which package should I update?",
    options: [{ label: "core", description: "the engine" }, { label: "web" }],
    multiple: false,
    custom: true,
  },
];

/** 一个正在运行、并且停下来问了一个问题的会话（经 MCP 的 delegate 委派）；桥的服务客户端记下发出的每个请求，并能让下一次“回复提问”发不出去。 */
async function setup() {
  const exec = new ManualExecutor("pi");
  exec.autoStart = true;
  exec.questionReply = true;
  const service = await startTestService({ homePrefix: "ensemble-mcp-oldservice-", executors: [exec], env: {}, managerConfig: { duplicateWindowMs: 0 } });
  const sent: Sent[] = [];
  let refuseNext: (() => void) | undefined;
  const client = new ServiceClient({
    paths: service.paths,
    ensure: async () => {
      throw new Error("the service should already be running");
    },
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      sent.push({ method, path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined });
      if (refuseNext && method === "POST" && QUESTION_REPLY.test(url.pathname)) {
        const beforeRefusing = refuseNext;
        refuseNext = undefined;
        beforeRefusing();
        throw connectionRefused();
      }
      return fetch(input, init);
    }) satisfies typeof fetch,
  });
  const bridge = new EnsembleBridge({ paths: service.paths, version: "test", env: {}, cwd: tmpdir(), client, openExternal: () => {} });
  const session = await connectBridge(bridge);

  const delegated = await session.call("delegate", { harness: "pi", task: "Build the service", cwd: tmpdir() });
  expect(delegated.isError, delegated.text).toBe(false);
  const sessionId = delegated.data?.["sessionId"] as string;
  const runId = delegated.data?.["runId"] as string;
  await until(() => service.hub.summary(sessionId)?.phase === "running", 4000, "the run to start");
  const questionId = exec.sessions[0]!.ask(runId, CHOICE);
  await until(() => service.hub.summary(sessionId)?.attention?.some((item) => item.kind === "question") === true, 4000, "the question to be raised");

  return {
    service,
    session,
    exec,
    sent,
    sessionId,
    questionId,
    /** 下一次回复提问的 POST 发不出去（连接被拒绝）；发之前先做 `beforeRefusing`（例如把服务换成老版本）。只作用一次。 */
    refuseNextReply(beforeRefusing: () => void = () => {}): void {
      refuseNext = beforeRefusing;
    },
  };
}

type Rig = Awaited<ReturnType<typeof setup>>;

/** 发给“回复提问”那条路由的请求，按发出的先后（含被拒绝的那一次）。 */
function replyRequests({ sent }: Rig): Sent[] {
  return sent.filter((request) => request.method === "POST" && QUESTION_REPLY.test(request.path));
}

const openCount = (rig: Rig): number => rig.service.hub.summary(rig.sessionId)?.openQuestions ?? 0;

/** 回复发出去时连接被拒绝，桥重新发现的服务是老服务：回复不再发出，主 Agent 读到的是“服务比插件旧”的说明。 */
async function refusedWhenTheServiceTurnsOutOlder(reply: Record<string, unknown>): Promise<void> {
  const rig = await setup();
  let advertised: readonly string[] | undefined;
  rig.refuseNextReply(() => {
    advertised = simulateOlderService(rig.service);
  });

  const result = await rig.session.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, ...reply });

  expect(advertised, "the new service advertises question replies, so the switch really took them away").toContain("session-questions");
  expect(result.isError).toBe(true);
  expect(result.text).toMatch(/older than this plugin and cannot take replies to questions/);
  expect(result.text).toContain("they can answer in the panel");
  expect(result.text).toContain(`${rig.service.url}/#/s/${rig.sessionId}`);
  expect(result.text).toContain("restart Ensemble");
  // 不是 404 之后的那句话。
  expect(result.text).not.toContain("list valid session ids");
  // 只发出过被拒绝的那一次，没有再发一遍：执行端没有收到任何回复，提问仍然待回答。
  expect(replyRequests(rig)).toHaveLength(1);
  expect(rig.exec.sessions[0]?.replies).toEqual([]);
  expect(openCount(rig)).toBe(1);
}

describe("replying to a question when the service is re-discovered after the reply could not be sent", () => {
  it("does not send an answer to an older service that has no such route, and says what to tell the user", async () => {
    await refusedWhenTheServiceTurnsOutOlder({ answer: "web" });
  });

  it("does not send a decline to an older service that has no such route, and says what to tell the user", async () => {
    await refusedWhenTheServiceTurnsOutOlder({ decline: true });
  });

  it("sends the same reply again when the service that answers has the same abilities (the usual case: it was only restarted)", async () => {
    const rig = await setup();
    rig.refuseNextReply();

    const result = await rig.session.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answer: "web" });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(`Answered question ${rig.questionId}`);
    const requests = replyRequests(rig);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toBe(requests[0]?.body);
    // 第二次到了服务：执行端收到了这一个回复，提问有了结局。
    expect(rig.exec.sessions[0]?.replies).toEqual([{ kind: "answer", questionId: rig.questionId, answers: [["web"]] }]);
    expect(openCount(rig)).toBe(0);
  });
});
