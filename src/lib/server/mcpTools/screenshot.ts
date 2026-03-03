/**
 * MCP tool: get_screenshot
 */

import { z } from 'zod';
import type { ToolRegistrar } from './types.js';
import { textResult } from './types.js';
import { getStream, getStreamRecordingDir } from '../streamManager.js';
import { extractFrame } from '../hlsUtils.js';
import { resolveCameraBounds } from '../db/index.js';

export function registerScreenshotTools(server: ToolRegistrar): void {
	server.tool(
		'get_screenshot',
		'Capture a JPEG frame from a stream at a given timestamp. Use region "camera" to crop to the channel\'s webcam camera bounds (resolved from channel_camera_bounds table).',
		{
			streamId: z.string(),
			timestamp: z.number(),
			timeFormat: z.enum(['master', 'local']).optional().default('local')
				.describe('"local" (stream-relative, default) or "master" (epoch)'),
			region: z.enum(['full', 'camera']).optional().default('full')
				.describe('"full" (entire frame, default) or "camera" (crop to channel\'s webcam region)')
		},
		async ({ streamId, timestamp, timeFormat, region }) => {
			const stream = getStream(streamId);
			if (!stream) return textResult(`Stream "${streamId}" not found.`, true);

			const recordingDir = getStreamRecordingDir(streamId);
			if (!recordingDir) return textResult(`No recording directory found for stream "${streamId}".`, true);

			let localTs = timestamp;
			if (timeFormat === 'master') {
				localTs = timestamp - stream.startedAt / 1000 + stream.offset;
			}

			if (localTs < 0) {
				return textResult(`Timestamp resolves to ${localTs.toFixed(1)}s (before stream start). Provide a later timestamp.`, true);
			}

			// Resolve camera crop filter if requested
			let cropFilter: string | null = null;
			if (region === 'camera') {
				const cam = resolveCameraBounds(stream.channel, timestamp);
				if (!cam) return textResult(`No camera bounds set for channel "${stream.channel}". Use set_camera_bounds first.`, true);
				cropFilter = `crop=iw*${cam.camW.toFixed(6)}:ih*${cam.camH.toFixed(6)}:iw*${cam.camX.toFixed(6)}:ih*${cam.camY.toFixed(6)}`;
			}

			try {
				const buffer = await extractFrame(recordingDir, localTs, cropFilter ?? undefined);
				return {
					content: [{
						type: 'image' as const,
						data: buffer.toString('base64'),
						mimeType: 'image/jpeg'
					}]
				};
			} catch (err) {
				return textResult(`Failed to extract frame: ${err instanceof Error ? err.message : String(err)}`, true);
			}
		}
	);
}
