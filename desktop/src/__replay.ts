/** Captured SSE frames from a real session (generated fixture, dev-only).
 * Session: session_1788997972145_z1cif — three turns: 你好 / 1234 / 123458, each a resume.
 * Feed to the real stream reducer via /preview.html?scene=replay. */
import type { EventEnvelope } from "./types.ts";

export const REPLAY: EventEnvelope[] = [
 {
  "type": "AGENT_RUN_STARTED",
  "at": 1788997972202,
  "payload": {}
 },
 {
  "type": "TURN_STARTED",
  "at": 1788997972202,
  "payload": {}
 },
 {
  "type": "MESSAGE_STARTED",
  "at": 1788997972202,
  "payload": {
   "message": {
    "role": "user",
    "content": [
     {
      "type": "text",
      "text": "你好"
     }
    ],
    "timestamp": 1788997972148
   }
  }
 },
 {
  "type": "MESSAGE_ENDED",
  "at": 1788997972202,
  "payload": {
   "message": {
    "role": "user",
    "content": [
     {
      "type": "text",
      "text": "你好"
     }
    ],
    "timestamp": 1788997972148
   }
  }
 },
 {
  "type": "MESSAGE_STARTED",
  "at": 1788997973304,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 0,
     "cacheWrite": 0,
     "totalTokens": 0,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0,
      "total": 0
     }
    },
    "stopReason": "pending",
    "timestamp": 1788997972189
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997973306,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "用户用",
      "thinkingSignature": "",
      "index": 0
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 0,
     "cacheWrite": 852,
     "totalTokens": 852,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0.0003195,
      "total": 0.0003195
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997972189,
    "responseId": "06f1245400a7d37df423db3226f029c6"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997973307,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "用户用",
      "thinkingSignature": "",
      "index": 0
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 0,
     "cacheWrite": 852,
     "totalTokens": 852,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0.0003195,
      "total": 0.0003195
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997972189,
    "responseId": "06f1245400a7d37df423db3226f029c6"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997973808,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "用户用中文说\"你好\"，这是一个问候。我应该用中文回复并询问我如何帮助他们。",
      "thinkingSignature": "",
      "index": 0
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 0,
     "cacheWrite": 852,
     "totalTokens": 852,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0.0003195,
      "total": 0.0003195
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997972189,
    "responseId": "06f1245400a7d37df423db3226f029c6"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997974455,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "用户用中文说\"你好\"，这是一个问候。我应该用中文回复并询问我如何帮助他们。",
      "thinkingSignature": "3ca77338e13b17b4fbfe760ae04f6a75db01929c83b49e1fde8d50857af67498"
     },
     {
      "type": "text",
      "text": "你好！我是 Forge 的工程代理，很高兴为你服务。\n\n我可以帮你完成以下任务：\n- ",
      "index": 1
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 0,
     "cacheWrite": 852,
     "totalTokens": 852,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0.0003195,
      "total": 0.0003195
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997972189,
    "responseId": "06f1245400a7d37df423db3226f029c6"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997974456,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "用户用中文说\"你好\"，这是一个问候。我应该用中文回复并询问我如何帮助他们。",
      "thinkingSignature": "3ca77338e13b17b4fbfe760ae04f6a75db01929c83b49e1fde8d50857af67498"
     },
     {
      "type": "text",
      "text": "你好！我是 Forge 的工程代理，很高兴为你服务。\n\n我可以帮你完成以下任务：\n- ",
      "index": 1
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 0,
     "cacheWrite": 852,
     "totalTokens": 852,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0.0003195,
      "total": 0.0003195
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997972189,
    "responseId": "06f1245400a7d37df423db3226f029c6"
   }
  }
 },
 {
  "type": "TEXT_DELTA",
  "at": 1788997974456,
  "payload": {
   "delta": "你好！我是 Forge 的工程代理，很高兴为你服务。\n\n我可以帮你完成以下任务：\n- "
  }
 },
 {
  "type": "TEXT_DELTA",
  "at": 1788997974955,
  "payload": {
   "delta": "读取、编写和编辑文件\n- 执行 bash 命令\n- 浏览和修改代码\n\n请告诉我你需要什么"
  }
 },
 {
  "type": "TEXT_DELTA",
  "at": 1788997975004,
  "payload": {
   "delta": "帮助？"
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997975122,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "用户用中文说\"你好\"，这是一个问候。我应该用中文回复并询问我如何帮助他们。",
      "thinkingSignature": "3ca77338e13b17b4fbfe760ae04f6a75db01929c83b49e1fde8d50857af67498"
     },
     {
      "type": "text",
      "text": "你好！我是 Forge 的工程代理，很高兴为你服务。\n\n我可以帮你完成以下任务：\n- 读取、编写和编辑文件\n- 执行 bash 命令\n- 浏览和修改代码\n\n请告诉我你需要什么帮助？"
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 69,
     "cacheRead": 0,
     "cacheWrite": 852,
     "totalTokens": 921,
     "cost": {
      "input": 0,
      "output": 8.28e-05,
      "cacheRead": 0,
      "cacheWrite": 0.0003195,
      "total": 0.0004023
     },
     "cacheWrite1h": 0,
     "reasoning": 24
    },
    "stopReason": "pending",
    "timestamp": 1788997972189,
    "responseId": "06f1245400a7d37df423db3226f029c6"
   }
  }
 },
 {
  "type": "MESSAGE_ENDED",
  "at": 1788997975128,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "用户用中文说\"你好\"，这是一个问候。我应该用中文回复并询问我如何帮助他们。",
      "thinkingSignature": "3ca77338e13b17b4fbfe760ae04f6a75db01929c83b49e1fde8d50857af67498"
     },
     {
      "type": "text",
      "text": "你好！我是 Forge 的工程代理，很高兴为你服务。\n\n我可以帮你完成以下任务：\n- 读取、编写和编辑文件\n- 执行 bash 命令\n- 浏览和修改代码\n\n请告诉我你需要什么帮助？"
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 69,
     "cacheRead": 0,
     "cacheWrite": 852,
     "totalTokens": 921,
     "cost": {
      "input": 0,
      "output": 8.28e-05,
      "cacheRead": 0,
      "cacheWrite": 0.0003195,
      "total": 0.0004023
     },
     "cacheWrite1h": 0,
     "reasoning": 24
    },
    "stopReason": "stop",
    "timestamp": 1788997972189,
    "responseId": "06f1245400a7d37df423db3226f029c6",
    "rawStopReason": "end_turn"
   }
  }
 },
 {
  "type": "COST_UPDATE",
  "at": 1788997975129,
  "payload": {
   "spent": 0.0004023,
   "budget": null
  }
 },
 {
  "type": "TURN_ENDED",
  "at": 1788997975129,
  "payload": {
   "toolResults": 0
  }
 },
 {
  "type": "AGENT_RUN_ENDED",
  "at": 1788997975130,
  "payload": {
   "messages": 2
  }
 },
 {
  "type": "SESSION_RESUMED",
  "at": 1788997987186,
  "payload": {
   "messagesRecovered": 3,
   "hasSteeringMessage": true
  }
 },
 {
  "type": "AGENT_RUN_STARTED",
  "at": 1788997987193,
  "payload": {}
 },
 {
  "type": "TURN_STARTED",
  "at": 1788997987194,
  "payload": {}
 },
 {
  "type": "MESSAGE_STARTED",
  "at": 1788997987194,
  "payload": {
   "message": {
    "role": "user",
    "content": [
     {
      "type": "text",
      "text": "1234"
     }
    ],
    "timestamp": 1788997987188
   }
  }
 },
 {
  "type": "MESSAGE_ENDED",
  "at": 1788997987194,
  "payload": {
   "message": {
    "role": "user",
    "content": [
     {
      "type": "text",
      "text": "1234"
     }
    ],
    "timestamp": 1788997987188
   }
  }
 },
 {
  "type": "MESSAGE_STARTED",
  "at": 1788997987976,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 820,
     "cacheWrite": 95,
     "totalTokens": 915,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 4.9199999999999997e-05,
      "cacheWrite": 3.5625e-05,
      "total": 8.482499999999999e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997987189
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997987977,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The",
      "thinkingSignature": "",
      "index": 0
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 820,
     "cacheWrite": 95,
     "totalTokens": 915,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 4.9199999999999997e-05,
      "cacheWrite": 3.5625e-05,
      "total": 8.482499999999999e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997987189,
    "responseId": "06f1246348094748447ec135bcb171a1"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997987977,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The",
      "thinkingSignature": "",
      "index": 0
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 820,
     "cacheWrite": 95,
     "totalTokens": 915,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 4.9199999999999997e-05,
      "cacheWrite": 3.5625e-05,
      "total": 8.482499999999999e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997987189,
    "responseId": "06f1246348094748447ec135bcb171a1"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997988629,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is just sending \"1234\" twice. This seems like they might be testing or just sending a simple",
      "thinkingSignature": "",
      "index": 0
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 820,
     "cacheWrite": 95,
     "totalTokens": 915,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 4.9199999999999997e-05,
      "cacheWrite": 3.5625e-05,
      "total": 8.482499999999999e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997987189,
    "responseId": "06f1246348094748447ec135bcb171a1"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997989270,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is just sending \"1234\" twice. This seems like they might be testing or just sending a simple message. I should acknowledge their message and ask if they need any help with their project.",
      "thinkingSignature": "28742444dfd36151b7554e7f067c4affb22cc228477235447bbdd32364d9e6c0"
     },
     {
      "type": "text",
      "text": "收到！你好 ",
      "index": 1
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 820,
     "cacheWrite": 95,
     "totalTokens": 915,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 4.9199999999999997e-05,
      "cacheWrite": 3.5625e-05,
      "total": 8.482499999999999e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997987189,
    "responseId": "06f1246348094748447ec135bcb171a1"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997989271,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is just sending \"1234\" twice. This seems like they might be testing or just sending a simple message. I should acknowledge their message and ask if they need any help with their project.",
      "thinkingSignature": "28742444dfd36151b7554e7f067c4affb22cc228477235447bbdd32364d9e6c0"
     },
     {
      "type": "text",
      "text": "收到！你好 ",
      "index": 1
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 820,
     "cacheWrite": 95,
     "totalTokens": 915,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 4.9199999999999997e-05,
      "cacheWrite": 3.5625e-05,
      "total": 8.482499999999999e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997987189,
    "responseId": "06f1246348094748447ec135bcb171a1"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997989272,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is just sending \"1234\" twice. This seems like they might be testing or just sending a simple message. I should acknowledge their message and ask if they need any help with their project.",
      "thinkingSignature": "28742444dfd36151b7554e7f067c4affb22cc228477235447bbdd32364d9e6c0"
     },
     {
      "type": "text",
      "text": "收到！你好 ",
      "index": 1
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 820,
     "cacheWrite": 95,
     "totalTokens": 915,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 4.9199999999999997e-05,
      "cacheWrite": 3.5625e-05,
      "total": 8.482499999999999e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788997987189,
    "responseId": "06f1246348094748447ec135bcb171a1"
   }
  }
 },
 {
  "type": "TEXT_DELTA",
  "at": 1788997989272,
  "payload": {
   "delta": "收到！你好 "
  }
 },
 {
  "type": "TEXT_DELTA",
  "at": 1788997989466,
  "payload": {
   "delta": "1234 😄\n\n有什么我可以帮你的吗？"
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788997989630,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is just sending \"1234\" twice. This seems like they might be testing or just sending a simple message. I should acknowledge their message and ask if they need any help with their project.",
      "thinkingSignature": "28742444dfd36151b7554e7f067c4affb22cc228477235447bbdd32364d9e6c0"
     },
     {
      "type": "text",
      "text": "收到！你好 1234 😄\n\n有什么我可以帮你的吗？"
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 60,
     "cacheRead": 820,
     "cacheWrite": 95,
     "totalTokens": 975,
     "cost": {
      "input": 0,
      "output": 7.2e-05,
      "cacheRead": 4.9199999999999997e-05,
      "cacheWrite": 3.5625e-05,
      "total": 0.00015682499999999998
     },
     "cacheWrite1h": 0,
     "reasoning": 44
    },
    "stopReason": "pending",
    "timestamp": 1788997987189,
    "responseId": "06f1246348094748447ec135bcb171a1"
   }
  }
 },
 {
  "type": "MESSAGE_ENDED",
  "at": 1788997989631,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is just sending \"1234\" twice. This seems like they might be testing or just sending a simple message. I should acknowledge their message and ask if they need any help with their project.",
      "thinkingSignature": "28742444dfd36151b7554e7f067c4affb22cc228477235447bbdd32364d9e6c0"
     },
     {
      "type": "text",
      "text": "收到！你好 1234 😄\n\n有什么我可以帮你的吗？"
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 60,
     "cacheRead": 820,
     "cacheWrite": 95,
     "totalTokens": 975,
     "cost": {
      "input": 0,
      "output": 7.2e-05,
      "cacheRead": 4.9199999999999997e-05,
      "cacheWrite": 3.5625e-05,
      "total": 0.00015682499999999998
     },
     "cacheWrite1h": 0,
     "reasoning": 44
    },
    "stopReason": "stop",
    "timestamp": 1788997987189,
    "responseId": "06f1246348094748447ec135bcb171a1",
    "rawStopReason": "end_turn"
   }
  }
 },
 {
  "type": "COST_UPDATE",
  "at": 1788997989631,
  "payload": {
   "spent": 0.0005591249999999999,
   "budget": null
  }
 },
 {
  "type": "TURN_ENDED",
  "at": 1788997989631,
  "payload": {
   "toolResults": 0
  }
 },
 {
  "type": "AGENT_RUN_ENDED",
  "at": 1788997989631,
  "payload": {
   "messages": 2
  }
 },
 {
  "type": "SESSION_RESUMED",
  "at": 1788998001463,
  "payload": {
   "messagesRecovered": 5,
   "hasSteeringMessage": true
  }
 },
 {
  "type": "AGENT_RUN_STARTED",
  "at": 1788998001468,
  "payload": {}
 },
 {
  "type": "TURN_STARTED",
  "at": 1788998001468,
  "payload": {}
 },
 {
  "type": "MESSAGE_STARTED",
  "at": 1788998001468,
  "payload": {
   "message": {
    "role": "user",
    "content": [
     {
      "type": "text",
      "text": "123458"
     }
    ],
    "timestamp": 1788998001464
   }
  }
 },
 {
  "type": "MESSAGE_ENDED",
  "at": 1788998001469,
  "payload": {
   "message": {
    "role": "user",
    "content": [
     {
      "type": "text",
      "text": "123458"
     }
    ],
    "timestamp": 1788998001464
   }
  }
 },
 {
  "type": "MESSAGE_STARTED",
  "at": 1788998002547,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 862,
     "cacheWrite": 80,
     "totalTokens": 942,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 5.171999999999999e-05,
      "cacheWrite": 3e-05,
      "total": 8.172e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788998001465
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788998002547,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The",
      "thinkingSignature": "",
      "index": 0
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 862,
     "cacheWrite": 80,
     "totalTokens": 942,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 5.171999999999999e-05,
      "cacheWrite": 3e-05,
      "total": 8.172e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788998001465,
    "responseId": "06f12471835e47d659ecd343c65d96c4"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788998002548,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The",
      "thinkingSignature": "",
      "index": 0
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 862,
     "cacheWrite": 80,
     "totalTokens": 942,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 5.171999999999999e-05,
      "cacheWrite": 3e-05,
      "total": 8.172e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788998001465,
    "responseId": "06f12471835e47d659ecd343c65d96c4"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788998003196,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is sending \"123458\" again. It seems like they might be testing or just sending random numbers. I should",
      "thinkingSignature": "",
      "index": 0
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 862,
     "cacheWrite": 80,
     "totalTokens": 942,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 5.171999999999999e-05,
      "cacheWrite": 3e-05,
      "total": 8.172e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788998001465,
    "responseId": "06f12471835e47d659ecd343c65d96c4"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788998003708,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is sending \"123458\" again. It seems like they might be testing or just sending random numbers. I should respond in a friendly way and ask if they need any help with something specific.",
      "thinkingSignature": "5dfbdae2c92b9e25d6d106f253e815418a2d27c3fd13eee444f1465305da0688"
     },
     {
      "type": "text",
      "text": "收到 123458！看起来你在发送数字测试",
      "index": 1
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 862,
     "cacheWrite": 80,
     "totalTokens": 942,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 5.171999999999999e-05,
      "cacheWrite": 3e-05,
      "total": 8.172e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788998001465,
    "responseId": "06f12471835e47d659ecd343c65d96c4"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788998003709,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is sending \"123458\" again. It seems like they might be testing or just sending random numbers. I should respond in a friendly way and ask if they need any help with something specific.",
      "thinkingSignature": "5dfbdae2c92b9e25d6d106f253e815418a2d27c3fd13eee444f1465305da0688"
     },
     {
      "type": "text",
      "text": "收到 123458！看起来你在发送数字测试",
      "index": 1
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 862,
     "cacheWrite": 80,
     "totalTokens": 942,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 5.171999999999999e-05,
      "cacheWrite": 3e-05,
      "total": 8.172e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788998001465,
    "responseId": "06f12471835e47d659ecd343c65d96c4"
   }
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788998003709,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is sending \"123458\" again. It seems like they might be testing or just sending random numbers. I should respond in a friendly way and ask if they need any help with something specific.",
      "thinkingSignature": "5dfbdae2c92b9e25d6d106f253e815418a2d27c3fd13eee444f1465305da0688"
     },
     {
      "type": "text",
      "text": "收到 123458！看起来你在发送数字测试",
      "index": 1
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 862,
     "cacheWrite": 80,
     "totalTokens": 942,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 5.171999999999999e-05,
      "cacheWrite": 3e-05,
      "total": 8.172e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788998001465,
    "responseId": "06f12471835e47d659ecd343c65d96c4"
   }
  }
 },
 {
  "type": "TEXT_DELTA",
  "at": 1788998003711,
  "payload": {
   "delta": "收到 123458！看起来你在发送数字测试"
  }
 },
 {
  "type": "TEXT_DELTA",
  "at": 1788998004279,
  "payload": {
   "delta": "。\n\n如果你需要帮助，可以告诉我你想做什么，比如：\n- 查看或编辑文件\n- 运行命令\n- 编写代码\n\n随时告诉我！"
  }
 },
 {
  "type": "MESSAGE_UPDATED",
  "at": 1788998004471,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is sending \"123458\" again. It seems like they might be testing or just sending random numbers. I should respond in a friendly way and ask if they need any help with something specific.",
      "thinkingSignature": "5dfbdae2c92b9e25d6d106f253e815418a2d27c3fd13eee444f1465305da0688"
     },
     {
      "type": "text",
      "text": "收到 123458！看起来你在发送数字测试。\n\n如果你需要帮助，可以告诉我你想做什么，比如：\n- 查看或编辑文件\n- 运行命令\n- 编写代码\n\n随时告诉我！"
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 0,
     "cacheRead": 862,
     "cacheWrite": 80,
     "totalTokens": 942,
     "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 5.171999999999999e-05,
      "cacheWrite": 3e-05,
      "total": 8.172e-05
     },
     "cacheWrite1h": 0
    },
    "stopReason": "pending",
    "timestamp": 1788998001465,
    "responseId": "06f12471835e47d659ecd343c65d96c4"
   }
  }
 },
 {
  "type": "MESSAGE_ENDED",
  "at": 1788998004474,
  "payload": {
   "message": {
    "role": "assistant",
    "content": [
     {
      "type": "thinking",
      "thinking": "The user is sending \"123458\" again. It seems like they might be testing or just sending random numbers. I should respond in a friendly way and ask if they need any help with something specific.",
      "thinkingSignature": "5dfbdae2c92b9e25d6d106f253e815418a2d27c3fd13eee444f1465305da0688"
     },
     {
      "type": "text",
      "text": "收到 123458！看起来你在发送数字测试。\n\n如果你需要帮助，可以告诉我你想做什么，比如：\n- 查看或编辑文件\n- 运行命令\n- 编写代码\n\n随时告诉我！"
     }
    ],
    "api": "anthropic-messages",
    "provider": "minimax-cn-anthropic",
    "model": "MiniMax-M2.7",
    "usage": {
     "input": 0,
     "output": 83,
     "cacheRead": 862,
     "cacheWrite": 80,
     "totalTokens": 1025,
     "cost": {
      "input": 0,
      "output": 9.96e-05,
      "cacheRead": 5.171999999999999e-05,
      "cacheWrite": 3e-05,
      "total": 0.00018131999999999998
     },
     "cacheWrite1h": 0,
     "reasoning": 44
    },
    "stopReason": "stop",
    "timestamp": 1788998001465,
    "responseId": "06f12471835e47d659ecd343c65d96c4",
    "rawStopReason": "end_turn"
   }
  }
 },
 {
  "type": "COST_UPDATE",
  "at": 1788998004474,
  "payload": {
   "spent": 0.000740445,
   "budget": null
  }
 },
 {
  "type": "TURN_ENDED",
  "at": 1788998004475,
  "payload": {
   "toolResults": 0
  }
 },
 {
  "type": "AGENT_RUN_ENDED",
  "at": 1788998004475,
  "payload": {
   "messages": 2
  }
 }
];
