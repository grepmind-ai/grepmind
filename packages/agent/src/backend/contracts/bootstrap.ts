export interface AgentCapabilities {
  multiBranch: boolean;
  artifactBatchImport: boolean;
  eventStream: boolean;
  agentWebSocket: boolean;
}

export interface AgentLimits {
  maxRevisionsPerSync: number;
  maxRevisionFilesPageSize: number;
  maxRevisionChangesPageSize: number;
  maxArtifactRefsPerBatch: number;
  maxArtifactBatchBytes: number;
}

export interface BootstrapResponse {
  agentApiVersion: 'v1';
  serverInstanceId: string;
  supportedFeatures: AgentCapabilities;
  limits: AgentLimits;
  defaultSyncPollIntervalMs: number;
  defaultEventHeartbeatMs?: number;
  defaultWebSocketHeartbeatMs?: number;
  defaultWebSocketReconnectBaseMs?: number;
}
