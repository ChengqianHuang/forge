import type { ForgePlugin } from "../types.ts";

export const sessionCommandsPlugin: ForgePlugin = {
  manifest: {
    id: "forge.session-commands",
    name: "Session commands",
    version: "1.0.0",
    // Slash commands only — the results are shown by the kernel's notice
    // timeline, so declaring "ui" claimed a surface this plugin does not own.
    capabilities: ["slash-command"],
    slashCommands: [
      { name: "compact", description: "Compact context at the next turn boundary" },
      { name: "status", description: "Show the current session status" },
      { name: "context", description: "Show context and token usage" },
    ],
  },
  activate(context) {
    return {
      slashCommands: [
        {
          name: "compact",
          description: "Compact context at the next turn boundary",
          execute() {
            context.requestCompaction();
            return { message: "已请求压缩上下文，将在下一轮边界执行。", tone: "ok" };
          },
        },
        {
          name: "status",
          description: "Show the current session status",
          execute() {
            return {
              message: `状态：${context.session.status} · 模型：${context.session.model.modelId} · 消息：${context.session.messages.length}`,
            };
          },
        },
        {
          name: "context",
          description: "Show context and token usage",
          execute() {
            const usage = context.session.usage;
            return {
              message: `上下文：${usage.lastContextTokens ?? "未知"} tokens · 累计输入 ${usage.tokensIn} · 累计输出 ${usage.tokensOut}`,
            };
          },
        },
      ],
    };
  },
};
