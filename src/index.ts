#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { NodeVM, VMScript } from 'vm2';
import { parse } from 'acorn';
import { createLogger, format, transports } from 'winston';

// Logger configuration
const logger = createLogger({
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'js-sandbox.log' })
  ]
});

interface ExecuteCodeArgs {
  code: string;
  timeout?: number;
  memory?: number;
}

class JSSandbox {
  private static readonly DEFAULT_TIMEOUT = 5000; // 5 seconds
  private static readonly DEFAULT_MEMORY = 50 * 1024 * 1024; // 50 MB
  private static readonly FORBIDDEN_PATTERNS = [
    'process',
    'require',
    '__dirname',
    '__filename',
    'global',
    'Buffer',
    'eval'
  ];

  private validateCode(code: string): void {
    try {
      // Static code analysis with Acorn
      parse(code, { ecmaVersion: 'latest' });

      // Check for forbidden patterns
      for (const pattern of JSSandbox.FORBIDDEN_PATTERNS) {
        if (code.includes(pattern)) {
          throw new Error(`Forbidden use of '${pattern}'`);
        }
      }
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Code validation error: ${error.message}`
      );
    }
  }

  private createSandbox(timeout: number, memory: number): NodeVM {
    return new NodeVM({
      console: 'redirect',
      sandbox: {},
      require: false,
      timeout,
      wrapper: 'none',
      eval: false,
      wasm: false
    });
  }

  async executeCode(args: ExecuteCodeArgs): Promise<{
    result: any;
    console: string[];
    executionTime: number;
    memoryUsage: number;
  }> {
    const timeout = args.timeout ?? JSSandbox.DEFAULT_TIMEOUT;
    const memory = args.memory ?? JSSandbox.DEFAULT_MEMORY;
    const consoleOutput: string[] = [];

    try {
      // Code validation
      this.validateCode(args.code);

      // Create sandbox
      const vm = this.createSandbox(timeout, memory);

      // Console redirection
      vm.on('console.log', (...args) => {
        consoleOutput.push(args.map(arg => String(arg)).join(' '));
      });

      // Measure execution time
      const startTime = process.hrtime();

      // Compile and execute code
      const script = new VMScript(args.code);
      const result = await vm.run(script);

      const [seconds, nanoseconds] = process.hrtime(startTime);
      const executionTime = seconds * 1000 + nanoseconds / 1000000;

      // Log execution
      logger.info('Code executed successfully', {
        executionTime,
        memoryUsage: process.memoryUsage().heapUsed,
        codeLength: args.code.length
      });

      return {
        result,
        console: consoleOutput,
        executionTime,
        memoryUsage: process.memoryUsage().heapUsed
      };
    } catch (error: any) {
      logger.error('Execution error', {
        error: error.message,
        code: args.code
      });

      throw new McpError(
        ErrorCode.InternalError,
        `Execution error: ${error.message}`
      );
    }
  }
}

class JSSandboxServer {
  private readonly server: Server;
  private readonly sandbox: JSSandbox;

  constructor() {
    this.server = new Server(
      {
        name: 'js-sandbox-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.sandbox = new JSSandbox();
    this.setupHandlers();
    
    this.server.onerror = (error) => {
      logger.error('MCP Server error', { error });
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers() {
    // List of available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'execute_js',
          description: 'Execute JavaScript code in an isolated environment',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'JavaScript code to execute'
              },
              timeout: {
                type: 'number',
                description: 'Maximum execution time in milliseconds',
                minimum: 100,
                maximum: 30000
              },
              memory: {
                type: 'number',
                description: 'Memory limit in bytes',
                minimum: 1024 * 1024,
                maximum: 100 * 1024 * 1024
              }
            },
            required: ['code']
          }
        }
      ]
    }));

    // Code execution handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'execute_js') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      const args = request.params.arguments;
      if (!args || typeof args.code !== 'string') {
        throw new McpError(
          ErrorCode.InvalidRequest,
          'The "code" parameter is required and must be a string'
        );
      }

      const executeArgs: ExecuteCodeArgs = {
        code: args.code,
        timeout: typeof args.timeout === 'number' ? args.timeout : undefined,
        memory: typeof args.memory === 'number' ? args.memory : undefined
      };

      const result = await this.sandbox.executeCode(executeArgs);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('JS Sandbox server started');
  }
}

const server = new JSSandboxServer();
server.run().catch(console.error);
