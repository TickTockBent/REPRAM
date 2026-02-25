/**
 * Shared types for the REPRAM node protocol.
 *
 * These match the Go types in internal/gossip/protocol.go and
 * the wire format in internal/gossip/http_transport.go.
 */

export type MessageType = "PUT" | "GET" | "PING" | "PONG" | "SYNC" | "ACK";

export interface NodeInfo {
  id: string;
  address: string;
  port: number;       // gossip port
  httpPort: number;    // HTTP API port
  enclave: string;
}

export interface Message {
  type: MessageType;
  from: string;          // sender node ID
  to: string;            // target node ID (empty for broadcast)
  key: string;
  data: Buffer;
  ttl: number;           // seconds
  timestamp: Date;
  messageId: string;
  nodeInfo?: NodeInfo;
}

/**
 * Wire format — matches Go's SimpleMessage JSON struct.
 * Field names and JSON keys must be exact for HMAC compatibility.
 */
export interface WireMessage {
  type: string;
  from: string;
  to?: string;
  key?: string;
  data?: string;           // base64-encoded (matches Go's []byte JSON encoding)
  ttl?: number;
  timestamp: number;       // Unix epoch seconds
  message_id: string;
  node_info?: WireNodeInfo;
}

export interface WireNodeInfo {
  id: string;
  address: string;
  port: number;
  http_port: number;
  enclave?: string;
}
