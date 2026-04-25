import type { AgentRpcError } from '../rpc/protocol.js';

export class AgentRpcRequestError extends Error {
  constructor(readonly rpcError: AgentRpcError) {
    super(rpcError.message);
    this.name = 'AgentRpcRequestError';
  }
}
