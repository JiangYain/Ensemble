/**
 * 仅供测试使用：经真实本地 HTTP 测服务的几份套件（service.test.ts、service.delegation.test.ts、service.models.test.ts、service.relink.test.ts）共用的委派辅助。
 * 真服务、带令牌的 API 客户端与 SSE 解析器在 service.fixtures.ts。
 */

import { tmpdir } from "node:os";
import type { Api } from "./service.fixtures";

export async function delegate(client: Api, task: string, extra: Record<string, unknown> = {}) {
  const response = await client.post("/api/sessions", { harness: "pi", task, cwd: tmpdir(), ...extra });
  const body = await client.json<{ sessionId: string; runId: string; summary: { phase: string } }>(response);
  return { response, body };
}
