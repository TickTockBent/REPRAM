// Package mcp implements a Model Context Protocol server over stdio that
// exposes a local *cluster.ClusterNode through four tools: repram_store,
// repram_retrieve, repram_exists, repram_list_keys. The wire format is
// newline-delimited JSON-RPC 2.0, matching the MCP stdio transport.
package mcp

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	"repram/internal/cluster"
	"repram/internal/storage"
)

const protocolVersion = "2024-11-05"

// Server reads JSON-RPC requests line by line from in and writes replies to
// out. Concurrent writes from request-handler goroutines are serialized
// through writeMu so framing stays intact.
type Server struct {
	cluster *cluster.ClusterNode
	minTTL  int
	maxTTL  int

	in  *bufio.Reader
	out io.Writer

	writeMu sync.Mutex
}

func NewServer(cn *cluster.ClusterNode, in io.Reader, out io.Writer, minTTL, maxTTL int) *Server {
	// Large initial buffer so big PUT payloads (capped at storage limits)
	// don't trip bufio's default 64KB line limit.
	br := bufio.NewReaderSize(in, 1<<20)
	return &Server{
		cluster: cn,
		minTTL:  minTTL,
		maxTTL:  maxTTL,
		in:      br,
		out:     out,
	}
}

// Run reads requests until stdin closes or ctx is cancelled. Each request
// is dispatched in its own goroutine so a slow tools/call doesn't head-of-
// line block the next request.
func (s *Server) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	defer wg.Wait()

	// Buffered + ctx-aware send so a Run() exit via ctx cancellation
	// doesn't strand the reader goroutine forever blocked on `lines <-`.
	// ReadBytes still pins the goroutine until stdin closes, but that's
	// always finite — the parent closes our stdin when it tears us down.
	lines := make(chan []byte, 1)
	readErr := make(chan error, 1)
	go func() {
		defer close(lines)
		for {
			line, err := s.in.ReadBytes('\n')
			if len(line) > 0 {
				line = bytesTrimRight(line, "\r\n")
				if len(line) > 0 {
					select {
					case lines <- line:
					case <-ctx.Done():
						readErr <- ctx.Err()
						return
					}
				}
			}
			if err != nil {
				readErr <- err
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case line, ok := <-lines:
			if !ok {
				err := <-readErr
				if errors.Is(err, io.EOF) {
					return nil
				}
				return err
			}
			wg.Add(1)
			go func(raw []byte) {
				defer wg.Done()
				s.dispatch(ctx, raw)
			}(line)
		}
	}
}

// ─── JSON-RPC types ─────────────────────────────────────────────────

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternalError  = -32603
)

func (s *Server) dispatch(ctx context.Context, raw []byte) {
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		// No ID available — emit a parse error with a null id so a
		// conforming client can still surface it. Notifications also fail
		// parse here, but that's correct: a malformed frame is a protocol
		// error either way.
		s.writeResponse(rpcResponse{
			JSONRPC: "2.0",
			ID:      json.RawMessage("null"),
			Error:   &rpcError{Code: codeParseError, Message: err.Error()},
		})
		return
	}

	// Notification: no id field. JSON-RPC requires we MUST NOT respond.
	isNotification := len(req.ID) == 0

	result, rpcErr := s.handle(ctx, req.Method, req.Params)

	if isNotification {
		return
	}

	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	if rpcErr != nil {
		resp.Error = rpcErr
	} else {
		resp.Result = result
	}
	s.writeResponse(resp)
}

func (s *Server) writeResponse(resp rpcResponse) {
	data, err := json.Marshal(resp)
	if err != nil {
		// Last-resort error envelope. If even this fails, we silently drop —
		// stdout is the only return channel and we can't log to it.
		data = []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"marshal failed"}}`)
	}
	data = append(data, '\n')
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, _ = s.out.Write(data)
}

// ─── Method dispatch ────────────────────────────────────────────────

func (s *Server) handle(ctx context.Context, method string, params json.RawMessage) (any, *rpcError) {
	switch method {
	case "initialize":
		return s.handleInitialize(params)
	case "notifications/initialized":
		// No-op; client tells server it's ready.
		return nil, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return s.handleToolsList(), nil
	case "tools/call":
		return s.handleToolCall(ctx, params)
	default:
		return nil, &rpcError{Code: codeMethodNotFound, Message: "method not found: " + method}
	}
}

func (s *Server) handleInitialize(params json.RawMessage) (any, *rpcError) {
	// Echo the client's protocol version if provided; otherwise advertise
	// the baseline we implement against. The MCP spec lets server pick.
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &p)
	}
	version := p.ProtocolVersion
	if version == "" {
		version = protocolVersion
	}

	return map[string]any{
		"protocolVersion": version,
		"capabilities": map[string]any{
			"tools": map[string]any{},
		},
		"serverInfo": map[string]any{
			"name":    "repram",
			"version": "2.1.0",
		},
	}, nil
}

// ─── Tools ──────────────────────────────────────────────────────────

type toolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func (s *Server) handleToolsList() any {
	return map[string]any{"tools": tools()}
}

func tools() []toolDef {
	return []toolDef{
		{
			Name: "repram_store",
			Description: "Store ephemeral data in the REPRAM network. Data is replicated across nodes and automatically expires after the specified TTL. " +
				"Use this for temporary coordination data, handoff payloads, scratchpad state, or any data that should not persist.\n\n" +
				"A unique key is generated automatically (UUID v4 hex). You will receive the key in the response — save it or share it with other agents who need to retrieve this data. The response also includes a quorum_status field: \"confirmed\" means the write was acknowledged by enough peers, \"pending\" means the data is on this node and replication is still in flight (it will gossip out shortly).\n\n" +
				"All data on REPRAM is ephemeral. There is no way to extend a TTL or recover expired data. If you need the data to last longer, store it again with a new TTL before expiration.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"data": map[string]any{
						"type":        "string",
						"description": "The data to store. Can be any string — plain text, JSON, base64-encoded binary, etc.",
					},
					"ttl_seconds": map[string]any{
						"type":        "number",
						"description": "Time-to-live in seconds. The data will be automatically deleted after this duration. Minimum 300 (5 minutes), maximum 86400 (24 hours). Default: 3600 (1 hour).",
					},
					"key": map[string]any{
						"type":        "string",
						"description": "Optional custom key. If omitted, a UUID-style hex key is generated automatically. Use a custom key when you need a predictable rendezvous point with another agent.",
					},
				},
				"required": []string{"data"},
			},
		},
		{
			Name: "repram_retrieve",
			Description: "Retrieve ephemeral data from the REPRAM network by key. Returns the stored data along with TTL metadata.\n\n" +
				"Returns null if the key does not exist or has expired. Expired data is permanently gone — this is by design. Do not treat a null response as an error; it is the normal lifecycle of ephemeral data.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"key": map[string]any{
						"type":        "string",
						"description": "The key to retrieve. This is the key returned by repram_store or shared by another agent.",
					},
				},
				"required": []string{"key"},
			},
		},
		{
			Name: "repram_exists",
			Description: "Check whether a key exists in the REPRAM network without retrieving its value. Returns existence status and remaining TTL.\n\n" +
				"This is the right tool for the coordination-token pattern: check if a lock key is present, poll for a heartbeat signal, or verify a handoff key is still alive — without transferring the payload. For large values, this avoids unnecessary bandwidth.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"key": map[string]any{
						"type":        "string",
						"description": "The key to check.",
					},
				},
				"required": []string{"key"},
			},
		},
		{
			Name: "repram_list_keys",
			Description: "List keys currently stored in the REPRAM network. Optionally filter by prefix.\n\n" +
				"Use this to discover what data is available, check if a coordination key exists, or enumerate keys in a namespace. Keys for expired data will not appear.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"prefix": map[string]any{
						"type":        "string",
						"description": "Optional prefix filter. Only keys starting with this string will be returned. Useful for namespacing (e.g., 'project-x/' to list all keys in that namespace).",
					},
				},
			},
		},
	}
}

type toolCallParams struct {
	Name      string                 `json:"name"`
	Arguments map[string]interface{} `json:"arguments"`
}

func (s *Server) handleToolCall(ctx context.Context, params json.RawMessage) (any, *rpcError) {
	var p toolCallParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcError{Code: codeInvalidParams, Message: err.Error()}
	}

	var (
		payload any
		err     error
	)
	switch p.Name {
	case "repram_store":
		payload, err = s.toolStore(ctx, p.Arguments)
	case "repram_retrieve":
		payload, err = s.toolRetrieve(p.Arguments)
	case "repram_exists":
		payload, err = s.toolExists(p.Arguments)
	case "repram_list_keys":
		payload, err = s.toolListKeys(p.Arguments)
	default:
		return nil, &rpcError{Code: codeMethodNotFound, Message: "unknown tool: " + p.Name}
	}

	if err != nil {
		// Per MCP convention, tool-execution failures travel through the
		// result envelope with isError=true rather than as JSON-RPC errors —
		// JSON-RPC errors are reserved for protocol-level problems.
		return map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": err.Error()},
			},
			"isError": true,
		}, nil
	}

	body, mErr := json.MarshalIndent(payload, "", "  ")
	if mErr != nil {
		return nil, &rpcError{Code: codeInternalError, Message: mErr.Error()}
	}
	return map[string]any{
		"content": []map[string]any{
			{"type": "text", "text": string(body)},
		},
	}, nil
}

func (s *Server) toolStore(ctx context.Context, args map[string]interface{}) (any, error) {
	data, ok := args["data"].(string)
	if !ok {
		return nil, fmt.Errorf("data: required string argument")
	}

	ttl := 3600
	if v, present := args["ttl_seconds"]; present {
		n, err := toInt(v)
		if err != nil {
			return nil, fmt.Errorf("ttl_seconds: %w", err)
		}
		ttl = n
	}
	if ttl < s.minTTL {
		ttl = s.minTTL
	}
	if ttl > s.maxTTL {
		ttl = s.maxTTL
	}

	key := ""
	if v, present := args["key"]; present {
		if k, ok := v.(string); ok {
			key = k
		}
	}
	if key == "" {
		key = newKey()
	}

	// Use a bounded context so a slow gossip storm can't wedge the MCP
	// loop. Mirrors the HTTP handler's 10s ceiling.
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Always include quorum_status so callers can deserialize into a fixed
	// shape. "confirmed" = local write + quorum acks landed within
	// REPRAM_WRITE_TIMEOUT; "pending" = local write succeeded, replication
	// still in flight (the data is on this node and will gossip out).
	quorumStatus := "confirmed"
	if err := s.cluster.Put(callCtx, key, []byte(data), time.Duration(ttl)*time.Second); err != nil {
		if errors.Is(err, cluster.ErrQuorumTimeout) {
			quorumStatus = "pending"
		} else if errors.Is(err, storage.ErrStoreFull) {
			return nil, fmt.Errorf("storage capacity exceeded")
		} else {
			return nil, fmt.Errorf("store failed: %w", err)
		}
	}

	return map[string]any{
		"key":           key,
		"ttl_seconds":   ttl,
		"expires_at":    time.Now().Add(time.Duration(ttl) * time.Second).UTC().Format(time.RFC3339),
		"quorum_status": quorumStatus,
	}, nil
}

func (s *Server) toolRetrieve(args map[string]interface{}) (any, error) {
	key, ok := args["key"].(string)
	if !ok || key == "" {
		return nil, fmt.Errorf("key: required string argument")
	}
	data, createdAt, originalTTL, exists := s.cluster.GetWithMetadata(key)
	if !exists {
		return nil, nil
	}
	remaining := originalTTL - time.Since(createdAt)
	if remaining < 0 {
		remaining = 0
	}
	return map[string]any{
		"data":                  string(data),
		"created_at":            createdAt.UTC().Format(time.RFC3339),
		"remaining_ttl_seconds": int(remaining.Seconds()),
		"expires_at":            createdAt.Add(originalTTL).UTC().Format(time.RFC3339),
	}, nil
}

func (s *Server) toolExists(args map[string]interface{}) (any, error) {
	key, ok := args["key"].(string)
	if !ok || key == "" {
		return nil, fmt.Errorf("key: required string argument")
	}
	_, createdAt, originalTTL, exists := s.cluster.GetWithMetadata(key)
	if !exists {
		return map[string]any{"exists": false}, nil
	}
	remaining := originalTTL - time.Since(createdAt)
	if remaining < 0 {
		remaining = 0
	}
	return map[string]any{
		"exists":                true,
		"remaining_ttl_seconds": int(remaining.Seconds()),
		"expires_at":            createdAt.Add(originalTTL).UTC().Format(time.RFC3339),
	}, nil
}

func (s *Server) toolListKeys(args map[string]interface{}) (any, error) {
	keys := s.cluster.Scan()
	if v, ok := args["prefix"].(string); ok && v != "" {
		filtered := keys[:0:0]
		for _, k := range keys {
			if strings.HasPrefix(k, v) {
				filtered = append(filtered, k)
			}
		}
		keys = filtered
	}
	sort.Strings(keys)
	return map[string]any{"keys": keys}, nil
}

// ─── helpers ────────────────────────────────────────────────────────

func toInt(v any) (int, error) {
	switch n := v.(type) {
	case float64:
		return int(n), nil
	case int:
		return n, nil
	case int64:
		return int(n), nil
	case json.Number:
		i, err := n.Int64()
		return int(i), err
	default:
		return 0, fmt.Errorf("expected number, got %T", v)
	}
}

// newKey returns a UUID-shaped hex string. It's not a strict RFC 4122 UUID —
// REPRAM keys are opaque to the system — but the format is familiar and
// collision-resistant for the per-agent scratchpad use case.
func newKey() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failure is fatal for any security-adjacent code path,
		// but here it would just degrade to time-based fallback.
		return fmt.Sprintf("k-%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
}

func bytesTrimRight(b []byte, cutset string) []byte {
	for len(b) > 0 && strings.IndexByte(cutset, b[len(b)-1]) >= 0 {
		b = b[:len(b)-1]
	}
	return b
}
