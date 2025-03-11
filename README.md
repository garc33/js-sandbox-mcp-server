# js-sandbox MCP Server

A Model Context Protocol server that provides a secure JavaScript execution environment.

<a href="https://glama.ai/mcp/servers/agatnhlgki">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/agatnhlgki/badge" alt="JavaScript Sandbox Server MCP server" />
</a>

## Features

### Tools
- `execute_js` - Executes JavaScript code in an isolated environment
  - Parameters:
    - `code` (required): JavaScript code to execute
    - `timeout` (optional): Maximum execution time in milliseconds (100-30000ms)
    - `memory` (optional): Memory limit in bytes (1MB-100MB)
  - Returns the result of code execution

### Security
- Isolated code execution in a controlled environment
- Configurable execution time and memory limits
- Protection against malicious code

## Development

Install dependencies:
```bash
npm install
```

Build the server:
```bash
npm run build
```

Development mode with auto-rebuild:
```bash
npm run watch
```

## Installation

To use with Claude Desktop, add the server configuration:

MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "js-sandbox": {
      "command": "/path/to/js-sandbox/build/index.js"
    }
  }
}
```

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We recommend using [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is available as:

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.