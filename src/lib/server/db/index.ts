// Barrel file — re-exports everything from domain modules
export { initDatabase, getDb, closeDatabase } from './persistenceBase.js';
export { saveStream, deleteStream, loadStream, loadAllStreams, updateStreamOffset } from './persistenceStreams.js';
export { saveTranscription, loadTranscriptionsInRange, countTranscriptions, loadWordTimestamps, deleteTranscriptions } from './persistenceTranscriptions.js';
export { saveChatMessage, saveChatMessagesBatch, countChatMessages, loadChatMessagesInRange, loadChatHeatmap, loadChatMessageByTwitchId } from './persistenceChat.js';
export { insertClipRegion, saveClipRegion, deleteClipRegion, loadAllClipRegions } from './persistenceClips.js';
export { resolveCameraBounds, saveCameraBounds, deleteCameraBounds, loadCameraBoundsForChannel } from './persistenceCameraBounds.js';
export { getChannelSettings, saveChannelSettings, loadAllChannelSettings, loadWatchlist, addToWatchlist, removeFromWatchlist } from './persistenceChannels.js';
export { type ExportRecord, saveExport, updateExportStatus, loadExport, loadAllExports, deleteExport } from './persistenceExports.js';
export { saveVideo, updateVideoRecord, loadVideo, loadAllVideos, deleteVideoRecord } from './persistenceVideos.js';
export { type YouTubeAccount, type YouTubeUploadRecord, saveYouTubeAccount, updateYouTubeAccountTokens, loadYouTubeAccount, loadYouTubeAccountByChannelId, loadAllYouTubeAccounts, deleteYouTubeAccount, saveYouTubeUpload, updateYouTubeUploadStatus, loadYouTubeUpload, loadAllYouTubeUploads, loadYouTubeUploadsByExport, deleteYouTubeUpload } from './persistenceYoutube.js';
export { loadAllCensorTerms, addCensorTerm, removeCensorTerm, clearCensorTerms } from './persistenceCensor.js';
