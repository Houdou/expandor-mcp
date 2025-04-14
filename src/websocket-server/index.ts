#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import WebSocket, { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';

const PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT) : 8742;

const ENABLE_LOGGING = process.env.ENABLE_LOGGING === 'true';
export function log(...args: any[]) {
  if (ENABLE_LOGGING) {
    console.log(...args);
  }
}

/**
 * Starts the server, connects via stdio, and schedules endpoint checks.
 */
async function runServer() {
  let expandor_ws: WebSocket | null = null;

  const wss = new WebSocketServer({ port: PORT });
  const server = new Server(
    {
      name: 'expandor-mcp',
      version: "0.2.2"
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          listChanged: true,
        },
        prompts: {
          listChanged: true,
        }
      },
    }
  );

  const waitForConnection = async () => {
    let interval: NodeJS.Timeout;

    return Promise.race([
      new Promise<void>((resolve, reject) => {
        interval = setInterval(() => {
          if (expandor_ws) {
            clearInterval(interval);
            log('Connected to client');
            resolve();
          } else {
            log('Waiting for client connection...');
          }
        }, 500);
      }),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Timeout waiting for client connection'));
        }, 30000);
      }),
    ]).finally(() => {
      if (interval) {
        clearInterval(interval);
      }
    })
  }

  const roundTripRegistry = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (error: unknown) => void;
  }>();
  const handleWebSocketMessage = async ({ message, ws }: {
    message: WebSocket.Data;
    ws: WebSocket;
  }) => {
    try {
      const parsedMessage = JSON.parse(message.toString());

      switch (parsedMessage.type) {
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }
        case 'client_connected': {
          server.sendResourceListChanged();
          server.sendPromptListChanged();
          server.sendToolListChanged();
          break;
        }
        case 'round_trip': {
          const { id, success, data, error } = parsedMessage;

          if (roundTripRegistry.has(id)) {
            const handler = roundTripRegistry.get(id)!;
            if (success) {
              roundTripRegistry.delete(id);
              handler.resolve(data);
            } else {
              roundTripRegistry.delete(id);
              handler.reject(error);
            }
          }
          break;
        }
        default: {
          log('Received unknown message:', parsedMessage);
        }
      }

    } catch (error) {
      log('Error handling message:', error);
    }
  };
  const callExpandor = async (message: object) => {
    if (!expandor_ws) {
      throw new Error("No client connected");
    }
    const id = nanoid(10);
    const calling = new Promise((resolve, reject) => {
      roundTripRegistry.set(id, { resolve, reject });
      expandor_ws!.send(JSON.stringify({ id, ...message }));
    });

    const promise = Promise.race([
      calling,
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error("Timeout"));
      }, 30000)),
    ]);

    try {
      const result = await promise;
      return result;
    } catch (error) {
      throw error;
    } finally {
      roundTripRegistry.delete(id);
    }
  };

  wss.on('connection', (ws) => {
    log('Client connected');
    if(expandor_ws != null) {
      log("Already connected to a client");
      ws.close(1001, "Already connected to a client");
      return;
    } else {
      expandor_ws = ws;
    }

    ws.on('message', (message) => {
      handleWebSocketMessage({ message, ws });
    });

    ws.on('close', () => {
      expandor_ws = null;
      log('Client disconnected');
    });

    ws.on('error', (error) => {
      log('WebSocket error:', error);
    });

    server.sendToolListChanged();
  });

  log(`WebSocket server is running on ws://localhost:${PORT}`);

  log("Initializing server...");

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    if(!expandor_ws) {
      // TODO: Use cache
      return {
        resources: []
      }
    }

    const resp = await callExpandor({
      type: "list_resources",
    }) as { resources: Array<object> };

    return {
      resources: resp.resources
    }
  })

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    if(!expandor_ws) {
      // TODO: Use cache
      return {
        resourceTemplates: []
      }
    }

    const resp = await callExpandor({
      type: "list_resource_templates",
    }) as { resourceTemplates: Array<object> };

    return {
      resourceTemplates: resp.resourceTemplates
    }
  })

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if(!expandor_ws) {
      log("No client connected");
      // TODO: Use cache
      return {
        contents: [
          {
            type: "text",
            message: "No client connected",
          }
        ],
      }
    }

    const resp = await callExpandor({
      type: "read_resource",
      params: request.params
    }) as { contents: Array<object> };

    return {
      contents: resp.contents,
    };
  })

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    if(!expandor_ws) {
      log("No client connected");
      return {
        prompts: []
      }
    }

    const resp = await callExpandor({
      type: "list_prompts",
    }) as { prompts: Array<object> };

    return {
      prompts: resp.prompts
    }
  })

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if(!expandor_ws) {
      log("No client connected");
      return {
        result: null
      }
    }

    const resp = await callExpandor({
      type: "complete_prompt",
      params: request.params
    }) as { messages: Array<object> };

    return {
      messages: resp.messages
    }
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!expandor_ws) {
      log("No client connected");
      // TODO: Use cache
      return {
        tools: []
      }
    }

    const resp = await callExpandor({
      type: "list_tools",
    }) as { tools: Array<object> };

    return {
      tools: resp.tools
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!expandor_ws) {
      log("No client connected");
      // TODO: Use cache
      return {
        content: [
          {
            type: "text",
            message: "No client connected",
          }
        ],
      }
    }

    const resp = await callExpandor({
      type: "call_tool",
      params: request.params
    }) as { content: Array<object>, success: boolean };

    return {
      isError: !resp.success,
      content: resp.content,
    };
  });

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
    log("Server connected to transport.");

    log("Client capabilities:", server.getClientCapabilities());
  } catch (error) {
    log("Error connecting server to transport:", error);
    throw error;
  }

  log("Expandor MCP Server running on stdio");

  return () => {
    server.close();
    wss.close();
    log("Server closed");
  }
}

// Start the server
const close_handler = runServer().catch(error => {
  log("Server failed to start:", error);
})

// On SIGINT, close the server
process.on('SIGINT', async () => {
  log("SIGINT received, closing server...");
  (await close_handler as () => void)()
  process.exit(0);
});