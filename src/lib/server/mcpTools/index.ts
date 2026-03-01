/**
 * MCP tool registration barrel.
 * Each module registers its tools on the provided McpServer instance.
 */

export { registerStreamTools } from './streams.js';
export { registerClipTools } from './clips.js';
export { registerSearchTools } from './search.js';
export { registerChannelTools } from './channels.js';
export { registerVideoTools } from './videos.js';
export { registerScreenshotTools } from './screenshot.js';
