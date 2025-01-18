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

// Configuration du logger
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
  private static readonly DEFAULT_TIMEOUT = 5000; // 5 secondes
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
      // Analyse statique du code avec Acorn
      parse(code, { ecmaVersion: 'latest' });

      // Vérification des motifs interdits
      for (const pattern of JSSandbox.FORBIDDEN_PATTERNS) {
        if (code.includes(pattern)) {
          throw new Error(`Usage interdit de '${pattern}'`);
        }
      }
    } catch (error: any) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Erreur de validation du code: ${error.message}`
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
      // Validation du code
      this.validateCode(args.code);

      // Création du bac à sable
      const vm = this.createSandbox(timeout, memory);

      // Redirection de la console
      vm.on('console.log', (...args) => {
        consoleOutput.push(args.map(arg => String(arg)).join(' '));
      });

      // Mesure du temps d'exécution
      const startTime = process.hrtime();

      // Compilation et exécution du code
      const script = new VMScript(args.code);
      const result = await vm.run(script);

      const [seconds, nanoseconds] = process.hrtime(startTime);
      const executionTime = seconds * 1000 + nanoseconds / 1000000;

      // Journalisation de l'exécution
      logger.info('Code exécuté avec succès', {
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
      logger.error('Erreur d\'exécution', {
        error: error.message,
        code: args.code
      });

      throw new McpError(
        ErrorCode.InternalError,
        `Erreur d'exécution: ${error.message}`
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
      logger.error('Erreur serveur MCP', { error });
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers() {
    // Liste des outils disponibles
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'execute_js',
          description: 'Exécute du code JavaScript dans un environnement isolé',
          inputSchema: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Code JavaScript à exécuter'
              },
              timeout: {
                type: 'number',
                description: 'Délai maximum d\'exécution en millisecondes',
                minimum: 100,
                maximum: 30000
              },
              memory: {
                type: 'number',
                description: 'Limite de mémoire en octets',
                minimum: 1024 * 1024,
                maximum: 100 * 1024 * 1024
              }
            },
            required: ['code']
          }
        }
      ]
    }));

    // Gestionnaire d'exécution du code
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'execute_js') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Outil inconnu: ${request.params.name}`
        );
      }

      const args = request.params.arguments;
      if (!args || typeof args.code !== 'string') {
        throw new McpError(
          ErrorCode.InvalidRequest,
          'Le paramètre "code" est requis et doit être une chaîne de caractères'
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
    logger.info('Serveur JS Sandbox démarré');
  }
}

const server = new JSSandboxServer();
server.run().catch(console.error);
