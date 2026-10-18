const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld(
  'aiDramaDesktop',
  Object.freeze({
    isDesktop: true,
    getRuntimeStatus: () => ipcRenderer.invoke('desktop:get-runtime-status'),
    getOptionalRuntimeAsset: (id) => ipcRenderer.invoke('desktop:get-optional-runtime-asset', id),
    installOptionalRuntimeAsset: (id) =>
      ipcRenderer.invoke('desktop:install-optional-runtime-asset', id),
    cancelOptionalRuntimeAsset: (id) =>
      ipcRenderer.invoke('desktop:cancel-optional-runtime-asset', id),
    removeOptionalRuntimeAsset: (id) =>
      ipcRenderer.invoke('desktop:remove-optional-runtime-asset', id),
    onRuntimeAssetProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('desktop:runtime-asset-progress', listener)
      return () => ipcRenderer.removeListener('desktop:runtime-asset-progress', listener)
    },
    runtimeAssetUrl: (id) => `aidrama-runtime://asset/${encodeURIComponent(id)}`,
    checkForUpdate: (input) => ipcRenderer.invoke('desktop:check-for-update', input),
    downloadAndInstallUpdate: (input) =>
      ipcRenderer.invoke('desktop:download-and-install-update', input),
    cancelUpdateDownload: () => ipcRenderer.invoke('desktop:cancel-update-download'),
    onUpdateProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('desktop:update-progress', listener)
      return () => ipcRenderer.removeListener('desktop:update-progress', listener)
    },
    getPersistedAuthState: () => ipcRenderer.invoke('auth:get-persisted-state'),
    savePersistedAuthState: (input) => ipcRenderer.invoke('auth:save-persisted-state', input),
    clearPersistedAuthState: () => ipcRenderer.invoke('auth:clear-persisted-state'),
    getWorkspaceStatus: () => ipcRenderer.invoke('workspace:get-status'),
    listLocalProjects: () => ipcRenderer.invoke('workspace:list-local-projects'),
    createLocalProject: (input) => ipcRenderer.invoke('workspace:create-local-project', input),
    deleteLocalProject: (projectId) =>
      ipcRenderer.invoke('workspace:delete-local-project', projectId),
    getLocalProjectData: (projectId) =>
      ipcRenderer.invoke('workspace:get-local-project-data', projectId),
    saveLocalProjectData: (projectId, data) =>
      ipcRenderer.invoke('workspace:save-local-project-data', { projectId, data }),
    updateLocalProject: (projectId, input) =>
      ipcRenderer.invoke('workspace:update-local-project', { projectId, input }),
    createLocalGenerationJob: (projectId, job) =>
      ipcRenderer.invoke('workspace:create-local-generation-job', { projectId, job }),
    getLocalGenerationJob: (jobId) =>
      ipcRenderer.invoke('workspace:get-local-generation-job', jobId),
    listLocalGenerationJobs: (projectId, page, pageSize) =>
      ipcRenderer.invoke('workspace:list-local-generation-jobs', { projectId, page, pageSize }),
    listAllLocalGenerationJobs: (page, pageSize) =>
      ipcRenderer.invoke('workspace:list-all-local-generation-jobs', { page, pageSize }),
    updateLocalGenerationJob: (jobId, action, input) =>
      ipcRenderer.invoke('workspace:update-local-generation-job', { jobId, action, input }),
    createLocalExportJob: (projectId, episodeId, input, idempotencyKey) =>
      ipcRenderer.invoke('workspace:create-local-export-job', {
        projectId,
        episodeId,
        input,
        idempotencyKey,
      }),
    listLocalExportJobs: (projectId, episodeId) =>
      ipcRenderer.invoke('workspace:list-local-export-jobs', { projectId, episodeId }),
    getLocalExportJob: (jobId) => ipcRenderer.invoke('workspace:get-local-export-job', jobId),
    updateLocalExportJob: (jobId, action, input) =>
      ipcRenderer.invoke('workspace:update-local-export-job', { jobId, action, input }),
    listLocalChatSessions: () => ipcRenderer.invoke('local-chat:list'),
    createLocalChatSession: (input) => ipcRenderer.invoke('local-chat:create', input),
    getLocalChatSession: (sessionId) => ipcRenderer.invoke('local-chat:get', sessionId),
    deleteLocalChatSession: (sessionId) => ipcRenderer.invoke('local-chat:delete', sessionId),
    appendLocalChatTurn: (sessionId, input) =>
      ipcRenderer.invoke('local-chat:append-turn', { sessionId, input }),
    attachLocalChatProject: (sessionId, projectId) =>
      ipcRenderer.invoke('local-chat:attach-project', { sessionId, projectId }),
    completeLocalImageGenerationJob: (jobId, input) =>
      ipcRenderer.invoke('workspace:complete-local-image-job', { jobId, input }),
    completeLocalMediaGenerationJob: (jobId, input) =>
      ipcRenderer.invoke('workspace:complete-local-media-job', { jobId, input }),
    listLocalImageCandidates: (projectId, targetType, targetId) =>
      ipcRenderer.invoke('workspace:list-local-image-candidates', {
        projectId,
        targetType,
        targetId,
      }),
    listLocalMediaCandidates: (projectId, storyboardId, mediaType) =>
      ipcRenderer.invoke('workspace:list-local-media-candidates', {
        projectId,
        storyboardId,
        mediaType,
      }),
    getLocalImageCandidate: (candidateId) =>
      ipcRenderer.invoke('workspace:get-local-image-candidate', candidateId),
    getLocalMediaCandidate: (candidateId) =>
      ipcRenderer.invoke('workspace:get-local-media-candidate', candidateId),
    updateLocalImageCandidate: (candidateId, action, input) =>
      ipcRenderer.invoke('workspace:update-local-image-candidate', { candidateId, action, input }),
    updateLocalMediaCandidate: (candidateId, action, input) =>
      ipcRenderer.invoke('workspace:update-local-media-candidate', { candidateId, action, input }),
    selectWorkspaceRoot: () => ipcRenderer.invoke('workspace:select-root'),
    ensureProject: (project) => ipcRenderer.invoke('workspace:ensure-project', project),
    getProject: (projectId) => ipcRenderer.invoke('workspace:get-project', projectId),
    importAssets: (projectId, category) =>
      ipcRenderer.invoke('workspace:import-assets', { projectId, category }),
    removeAsset: (projectId, assetId) =>
      ipcRenderer.invoke('workspace:remove-asset', { projectId, assetId }),
    reconcileAssetIds: (projectId, mappings) =>
      ipcRenderer.invoke('workspace:reconcile-asset-ids', {
        projectId,
        mappings: Array.isArray(mappings)
          ? mappings.map(({ clientAssetId, assetId }) => ({ clientAssetId, assetId }))
          : mappings,
      }),
    assetPreviewUrl: (projectId, assetId) =>
      `aidrama-asset://preview/project/${encodeURIComponent(projectId)}/asset/${encodeURIComponent(assetId)}`,
    revealAsset: (projectId, assetId) =>
      ipcRenderer.invoke('workspace:reveal-asset', { projectId, assetId }),
    revealProject: (projectId) => ipcRenderer.invoke('workspace:reveal-project', projectId),
    exportVideoAssets: (projectId, items) =>
      ipcRenderer.invoke('workspace:export-video-assets', { projectId, items }),
    listLocalAiConnections: () => ipcRenderer.invoke('local-ai:list'),
    saveLocalAiConnection: (input) => ipcRenderer.invoke('local-ai:save', input),
    discoverLocalAiModels: (input) => ipcRenderer.invoke('local-ai:discover-models', input),
    deleteLocalAiConnection: (id, version) =>
      ipcRenderer.invoke('local-ai:delete', { id, version }),
    testLocalAiAddress: (id) => ipcRenderer.invoke('local-ai:test-address', id),
    generateLocalText: (input) => ipcRenderer.invoke('local-ai:generate-text', input),
    generateLocalImage: (input) => ipcRenderer.invoke('local-ai:generate-image', input),
    generateLocalMedia: (input) => ipcRenderer.invoke('local-ai:generate-media', input),
    generatedCandidatePreviewUrl: (projectId, candidateId) =>
      `aidrama-asset://preview/project/${encodeURIComponent(projectId)}/candidate/${encodeURIComponent(candidateId)}`,
    discardGeneratedImage: (projectId, candidateId) =>
      ipcRenderer.invoke('workspace:discard-generated-image', { projectId, candidateId }),
    discardGeneratedMedia: (projectId, candidateId) =>
      ipcRenderer.invoke('workspace:discard-generated-media', { projectId, candidateId }),
    cachePlatformImage: (input) => ipcRenderer.invoke('workspace:cache-platform-image', input),
    saveGeneratedImage: (input) => ipcRenderer.invoke('workspace:save-generated-image', input),
    saveGeneratedMedia: (input) => ipcRenderer.invoke('workspace:save-generated-media', input),
    extractVoiceSample: (input) => ipcRenderer.invoke('desktop:extract-voice-sample', input),
    extractLastVideoFrame: (input) => ipcRenderer.invoke('desktop:extract-last-video-frame', input),
    extractVideoFrame: (input) => ipcRenderer.invoke('desktop:extract-video-frame', input),
    renderPoseProxy: (input) => ipcRenderer.invoke('desktop:render-pose-proxy', input),
    cancelPoseProxy: (taskId) => ipcRenderer.invoke('desktop:cancel-pose-proxy', taskId),
    onPoseProxyProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('desktop:pose-proxy-progress', listener)
      return () => ipcRenderer.removeListener('desktop:pose-proxy-progress', listener)
    },
    composeEpisode: (input) => ipcRenderer.invoke('desktop:compose-episode', input),
    cancelEpisodeExport: (exportId) => ipcRenderer.invoke('desktop:cancel-export', exportId),
    onExportProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('desktop:export-progress', listener)
      return () => ipcRenderer.removeListener('desktop:export-progress', listener)
    },
  }),
)
